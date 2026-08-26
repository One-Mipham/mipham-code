# Mipham Code /loop 唤醒接线（真 re-invocation）

> **版本**: 1.0.0
> **日期**: 2026-08-26
> **状态**: 设计完成，待实现
> **参考**: Claude Code 2.1.243 `/loop` 本地循环语义 + `ScheduleWakeup` 的 `noop` 折叠；Mipham 自测结论（`/loop auto` 半环：启动/记录 ✅，自动续跑 ⚠️）
> **路线图**: 实现计划待 writing-plans 阶段产出

---

## 一、目标

把 `/loop` 从「半环」补成「全环」——ScheduleWakeup 的 timer 到期后**真的重新把 loop prompt 喂回引擎**，在同一终端会话内继续跑，对齐 Claude Code 的本地 `/loop`（本地机器、终端内、自定步长），**不走** daemon 后台 worker（那更接近 CC 的 `/schedule` 云端 routine，语义不同）。

**当前现状（半环根因）**：

| 环节                                             | 状态                                                  |
| ------------------------------------------------ | ----------------------------------------------------- |
| `/loop auto` 建 journal + 注入 self-pacing 提示  | ✅                                                    |
| ScheduleWakeup `setTimeout` 到期后重跑           | ❌ 到期只删 timer，不 re-invoke                       |
| `logAutoloopIteration` 被调用（iterations 递增） | ❌ 只出现在提示文本，无代码/工具调用，iterations 恒 0 |
| loop 消耗的 token 记账                           | ❌ journal 不记 token                                 |

**非目标（范围外）**：

- 不接 daemon `ScheduleManager`（后台 worker + 固定 cron，非本地 `/loop` 语义）
- 不做跨进程 / 云端 loop 持久化（本 session 内 timer，进程退出 = loop 结束）
- 不做 loop 的多会话并发（单 session 单 loop）
- 不做「失控 loop 自动熔断」的完整策略（只做最大迭代护栏，见 §七）

**调度全景（三套并存，勿混）**：

| 调度                                 | 存储                    | 会真 re-invoke        | 定位                                |
| ------------------------------------ | ----------------------- | --------------------- | ----------------------------------- |
| `ScheduleWakeup`（本 spec 改造对象） | 内存 timer              | Phase 1 起 ✅         | `/loop` 本地终端内循环              |
| daemon `ScheduleManager`             | SQLite + REST           | ✅                    | 后台持久 schedule ≈ CC `/schedule`  |
| `CronCreate`（CLI 工具）             | `~/.mipham/cron/*.json` | ❌ 孤儿（只写没人读） | 待 cleanup：接 daemon 或 deprecated |

`CronCreate` 与 daemon `ScheduleManager` **零接线**（`cron.ts` 不调 daemon API，daemon 不读 cron 文件），是「half-cron」——本 spec **不动它**，另立 cleanup 议题。

---

## 二、设计决策

| 维度           | 选择                                                                                                                   | 理由                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 执行上下文     | **进程内**：timer 到期 → 重新调 `engine.process(loopPrompt)`，输出渲染在同一终端                                       | 对齐 CC `/loop`（本地终端内循环），区别于 daemon 后台                         |
| re-invoke 触发 | ScheduleWakeup 的 timer 到期 → 调**引擎注册的 `onWakeup(prompt)` 回调**                                                | 工具保持无引擎依赖（继续走 module 级 timer + 回调注册）；引擎拥有 turn 调度权 |
| 并发模型       | **单 turn 锁**（复用 app.tsx 的 `turnIdRef`）；唤醒时 busy → **排队**，idle → 立即跑；用户输入优先于排队中的 loop 唤醒 | 避免 loop turn 与用户 turn 交叠；用户实时交互不被 loop 抢占                   |
| 自定步长       | `/loop auto` 的 prompt 让 AI 调 ScheduleWakeup 动态 `delaySeconds`；timer 到期即下一轮，AI 用 `stop:true` 结束         | 天然覆盖 auto，无需 daemon 的固定 cron                                        |
| 迭代记录       | `logAutoloopIteration` 由**引擎在 loop turn 结束时自动调用**（不依赖 AI 手动调），iterations 真递增                    | 修「只写不读」半环；AI 手动调不可靠，引擎钩子更稳                             |
| token 记账     | journal 加 `startTokens`/`totalTokens`；loop 启动快照 `UsageTracker.totalApiTokens`，每轮记 delta                      | #1 `/usage` Loops 的地基                                                      |
| 空闲折叠       | ScheduleWakeup 加 `noop: boolean` 参数；UI 把连续 `noop` 唤醒折叠成一行                                                | #53                                                                           |

---

## 三、架构拓扑

```
用户输入 ──► app.tsx handleSubmit ──► engine.process(userInput) ──► provider
                ▲                                  ▲
                │ 单 turn 锁（turnIdRef）           │
                │                                  │ 唤醒队列 drain
                │                              ┌───┴────┐
                │                              │ engine │  runLoopTurn(prompt)
                │                              └───▲────┘
                │                                  │ onWakeup(prompt) 回调
                └──────────（用户 turn 优先）        │
                                         ┌─────────┴─────────┐
                                         │ schedule-wakeup   │
                                         │  setTimeout(...)  │ 到期 → onWakeup
                                         └───────────────────┘
                                                  ▲
                                                  │ ScheduleWakeup(delaySeconds, noop?, prompt)
                                                  │ （AI 在 loop turn 内调用）
                                          loop turn 输出 → autoloop-journal 记 iterations + token delta
```

**关键点**：timer 到期后，引擎把 loop prompt 排进**唤醒队列**；app.tsx 的 turn loop 在**空闲时** drain 队列 → 复用同一条 `runTurn` 路径跑 `engine.process(loopPrompt)`，输出与用户 turn 一样渲染到终端。

---

## 四、组件与职责

### 4.1 `schedule-wakeup.ts`（工具，改造）

- timer 到期回调从「只删自己」改为「删自己 + 调已注册的 `onWakeup(prompt)`」。
- 新增 `noop?: boolean` 参数：`noop:true` 表示「本轮无事可报」，仅用于 UI 折叠，不改变 re-invoke 语义。
- 保留 `stop:true` 取消该 session 全部 timer。
- 新增 module 级 `registerWakeupHandler(fn)`：由引擎在启动时注入（引擎拥有回调，工具保持无引擎 import）。

### 4.2 `engine.ts`（引擎，新增）

- `registerWakeupHandler`：接住 schedule-wakeup 的回调，把 prompt 入唤醒队列。
- 唤醒队列 + 单 turn 锁：`isTurnActive` 标志；空闲时 `runLoopTurn(prompt)`。
- `runLoopTurn(prompt)`：`await this.process(prompt)`，产出 StreamChunk 供 UI 渲染；turn 结束后标记空闲、继续 drain。
- loop turn 结束时自动 `logAutoloopIteration(sessionId, summary)` + 记 token delta（Phase 2）。

### 4.3 `app.tsx`（UI，改造）

- 把 `handleSubmit` 抽成可复用的 `runTurn(input, source: 'user' | 'loop')`，两者共用同一渲染路径 + `turnIdRef` 并发护栏。
- 监听引擎的「唤醒队列有待跑」信号：空闲时调 `runTurn(loopPrompt, 'loop')`。
- `noop` 折叠：连续 `noop` 唤醒折叠成一行（`💤 still idle (N ticks)`）。

### 4.4 `autoloop-journal.ts`（改造）

- `logAutoloopIteration` 从「无人调用」改为被引擎 loop turn 结束钩子调用。
- journal 加 `startTokens`/`totalTokens`；`recordLoopTokens(delta)` 累计。

### 4.5 `commands.ts` `/loop`（改造）

- 创建 journal 时快照 `engine.getUsageTracker().totalApiTokens` 存 `startTokens`。
- 固定间隔 `/loop <interval>` 直接走 ScheduleWakeup（真 timer，不再静默）。

---

## 五、数据流（一轮 `/loop auto` 生命周期）

```
1. 用户 /loop auto "monitor CI"
   → createAutoloopJournal(sessionId, prompt, startTokens)
   → forwardToAI: autoPrompt（告诉 AI 用 ScheduleWakeup 自定步长 + logAutoloopIteration）

2. AI 跑第一轮（engine.process(autoPrompt)）：
   做任务 → 调 ScheduleWakeup(delaySeconds=180, reason=…, prompt=loopId, noop?=false)
   → schedule-wakeup 设 180s timer

3. 180s 到期 → schedule-wakeup 调 onWakeup(prompt)
   → engine 入唤醒队列 → app.tsx 空闲时 runTurn(loopPrompt, 'loop')
   → engine.process(loopPrompt) 跑下一轮

4. 每轮结束 → engine 调 logAutoloopIteration(sessionId, summary) + recordLoopTokens(delta)
   → journal.iterations++ / totalTokens += delta

5. 任务完成 → AI 调 ScheduleWakeup(stop:true) → 取消 timer，loop 结束
   任务未完成 → 回到步骤 2（自定下一个 delay）
```

---

## 六、并发模型

| 场景                         | 行为                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| timer 到期，引擎空闲         | 立即 `runLoopTurn`                                             |
| timer 到期，用户 turn 进行中 | loop prompt 入唤醒队列，等当前 turn 结束                       |
| 排队期间用户又输入           | **用户输入优先**：loop 唤醒让位（或丢弃该次唤醒，下一轮再跑）  |
| loop turn 进行中，用户输入   | 用户输入打断 loop turn（复用现有 abort 路径），loop 下一轮自愈 |

**不变量**：任一时刻最多一个 turn 在跑（复用 `turnIdRef`）；loop turn 与用户 turn 复用同一 `runTurn`，天然受同一把锁约束。

---

## 七、错误处理

- **timer 触发时进程正忙**：排队不丢；队列满（>1 待跑）则丢弃旧唤醒、保留最新。
- **进程退出 / 会话清理**：`cancelAllSessionTimers` 已存在，补「清空唤醒队列 + 标记 loop 停止」。
- **用户中断 loop turn**：复用现有 abort 路径，journal 记 `status:'stopped'`。
- **最大迭代护栏**：journal 加 `maxIterations`（默认如 100），达到上限自动 `completeAutoloopJournal(…,'stopped')` 并停止 re-invoke——防失控循环烧 token（对齐 CC #64744 教训，只做护栏不做完整熔断）。

---

## 八、测试策略

| 层                 | 用例                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| schedule-wakeup    | 假 timer：到期触发 `onWakeup`；`stop` 取消；`noop` 透传                     |
| engine             | 唤醒入队 + 单 turn 锁（busy 时不并发跑）；队列 drain 顺序                   |
| journal            | `logAutoloopIteration` 递增 iterations；`recordLoopTokens` 累计 totalTokens |
| /usage Loops（#1） | 读 journal 显示 iterations / totalTokens / tokensPerRun / lastRun           |
| noop 折叠（#53）   | 连续 noop 折叠成一行，非 noop 打断折叠                                      |
| 端到端             | 假 timer 触发 → loop 跑满一轮 → journal 递增                                |

---

## 九、分阶段

| 阶段        | 内容                                                                               | 交付                      |
| ----------- | ---------------------------------------------------------------------------------- | ------------------------- |
| **Phase 1** | 真 re-invoke：ScheduleWakeup timer → onWakeup → 唤醒队列 → runLoopTurn；单 turn 锁 | `/loop <interval>` 真循环 |
| **Phase 2** | 迭代记录 + token 记账：logAutoloopIteration 接线 + journal token 字段              | `/loop auto` 可观测       |
| **Phase 3** | #1 `/usage` Loops 分解 + #53 noop 空闲折叠                                         | 两条 P1 收口              |

Phase 1 是核心（半环 → 全环）；Phase 2/3 是收尾（把 loop 变可观测 + 两条延后 P1）。

---

## 十、风险与缓解

| 风险                                             | 缓解                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| 并发复杂度（loop turn vs 用户 turn）             | 复用 `turnIdRef` 单 turn 锁；loop 唤醒只排队不抢占；用户优先          |
| token 归因模糊（loop 与主会话共用 UsageTracker） | 用「loop 启动快照 + 每轮 delta」近似，/usage 标注「自 loop 启动以来」 |
| 失控循环烧 token                                 | 最大迭代护栏 + `stop:true` 语义 + 文档明示                            |
| 唤醒队列在 UI 未挂载时无人 drain                 | 引擎持有队列，UI 挂载后再 drain；进程退出即丢弃                       |

---

## 十一、关联

- [[2026-08-26-mipham-code-cc-243-p1-alignment]]（#1 / #53 延后来源）
- `mipham-code-cc-242-245-analysis`（memory）
- **CronCreate 孤儿**：CLI `CronCreate` 只写 `~/.mipham/cron/*.json`、无消费方；daemon `ScheduleManager` 走 SQLite + REST，两者零接线。另立 cleanup 议题（接 daemon 或 deprecated），不在本 spec 范围。
