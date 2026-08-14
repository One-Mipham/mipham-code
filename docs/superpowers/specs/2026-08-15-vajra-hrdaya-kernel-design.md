# Mipham Code Vajra-Hṛdaya 内核设计

> **版本**: 1.0.0
> **日期**: 2026-08-15
> **状态**: 设计完成，待评审
> **参考**: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）、[cordiverse/cordis](https://github.com/cordiverse/cordis)、[cordiverse/paper](https://github.com/cordiverse/paper)
> **路线图**: 里程碑 0–3（strangler fig），逐一收掉三条 harness 旧账

---

## 一、背景与目标

### 1.1 问题：有枝无干

Mipham Code 已长成 41k 行枝繁叶茂的代码，但缺一个把各处「缝合」起来的内核。三个此前压下的 harness 议题，本质是同一根的三张脸：

| 旧账 | 症状（实测） | 根因 |
|---|---|---|
| **测试可观测性** | `full-pipeline.test.ts` 条件化（有 key 才真实打 API）；`discovery.test.ts` 与 `file-inbox.test.ts` 并行清共享目录有 flake | 无 append-only 源流，replay 无从谈起 |
| **编排边界** | `tools/index.ts` 把 32 个工具硬编码进一个数组；provider/tools/skills 三套孤立 `Map` 注册 | 无能力缝（seam），加能力=改源码 |
| **版本/依赖治理** | `apps/cli/src/shared` 与 `@mipham/shared` 双份漂移；数字 stale | 组合是代码不是声明，无分层 patch |

**病根实例**：`tools/file/read.ts:6-10` 用模块级可变全局 `credentialConfig` + setter 走私依赖——依赖不是注入的，是绕道塞进去的。这是「有枝无干」的最直接症状。

### 1.2 参考：DSH/Cordis 的答案

DeepSeek Harness（`dsh`，2026-08-13 v0.1，MIT）用三件套回答了「harness engineering」：

1. **会话日志单一事实源**——「Model-visible means logged」，fork/resume/replay/telemetry/persistence 全从同一条 append-only 流派生，`deriveMessages()` 投影模型历史。
2. **能力缝（seam）**——一个可换能力 = Service Definition（拥有 `ctx.<key>` + 词汇类型的抽象类）+ Service Provider（实现）+ Consumer（注入）。
3. **Cordis 内核**——两正交性质：**时间可组合**（每个 `ctx.effect()` 注册带逆，卸载栈式 LIFO 回滚）+ **空间可组合**（`inject` 声明依赖，加载顺序由服务需求推出），外加事件四派发 `emit/waterfall/parallel/serial`。

### 1.3 决策

| 维度 | 选择 | 理由 |
|---|---|---|
| 构建 | **自建内核**，不 vendor Cordis | 作者 Shigma 已入 DeepSeek（直接竞品），v4 API 未稳定；CRSI 叙事要求自我改进的系统拥有自己的地基 |
| 命名 | **Vajra-Hṛdaya**（金刚·心） | Vajra=不可摧坏（对 Cordis 的「心」，对组合不破的性质），Hṛdaya=心（对「kernel」） |
| 词汇 | 通用 CS 术语保留，品牌/概念层自立 | `Context`/`inject`/`effect`/`emit` 是行业通用词，重命名为梵语是 cargo-cult；「命名卫生」落在内核名与概念框架 |
| 迁移 | **strangler fig**（绞杀），不推倒重写 | 41k 行 + 1300 测试 + CI 不能断；旧 registry 继续工作直到逐缝切换 |

---

## 二、核心概念与词汇

| 概念 | 定义 | 对应 Cordis 术语 |
|---|---|---|
| **Context（心脉）** | 服务仓库 + 事件总线 + 可逆效应栈；组件与运行时的唯一接口 | Context |
| **Service（组件）** | 一个带可选 `inject` 与 `apply(ctx)` 的函数/对象 | Plugin / Service |
| **effect（可逆效应）** | 一次注册，自带逆；卸载时 LIFO 回滚 | effect / disposal |
| **inject（注入）** | 按服务键声明依赖；依赖到位才激活 | inject |
| **seam（能力缝）** | 可换能力三角：Definition/Provider/Consumer | seam |
| **scope（作用域）** | per-agent 注册域：global vs scoped + shadowing | scope |
| **会话日志（单一事实源）** | append-only `SessionEvent` 流；一切派生自此 | session log |

---

## 三、内核 API（Vajra-Hṛdaya heart）

位置：`apps/cli/src/vajra/`（M0 起步于 CLI 内，若 web/daemon 出现第二消费者再抽 `packages/`；YAGNI）。

```ts
type Disposer = () => void // M0 同步析构；异步析构推迟到 M1 会话日志落地时加宽

interface Service {
  inject?: string[]                  // 声明的依赖（服务键）
  apply(ctx: Context): void | Disposer
}

class Context {
  constructor(parent?: Context)

  // ── 空间可组合 ──
  provide<T>(key: string, value: T): Disposer
  get<T>(key: string): T | undefined
  has(key: string): boolean
  // 依赖注入走 Service.inject 声明字段 + mount 解析（见 §3.2），无独立的 Context.inject 方法

  // ── 时间可组合 ──
  effect(fn: () => Disposer | void): Disposer             // 注册带逆
  on(event: string, fn: Listener): Disposer

  // ── 事件四派发 ──
  emit(event: string, ...args: unknown[]): void           // 观察，无返回值
  waterfall<T>(event: string, value: T, ...args): Promise<T>  // 中间件，可短路
  parallel(event: string, ...args): Promise<unknown[]>    // 并发
  serial(event: string, ...args): Promise<unknown[]>      // 顺序 await

  // ── 生命周期 ──
  mount(service: Service): Disposer                       // 依赖解析 + 状态机
  scope(key: unknown): Context                            // per-agent 子 context
  dispose(): void                                         // LIFO 回滚全部未撤销 effect
}
```

### 3.1 事件模式是契约，不是派发点选择

（spike 的简化 → 真内核的深化）每个事件名在类型层声明其派发模式，派发方法做校验：

```ts
interface EventMap {
  'tools/pre-execute': { mode: 'waterfall'; in: ExecReq; out: ExecReq }
  'agent/pre-step':     { mode: 'waterfall'; in: Step; out: Step | 'reject' }
  'session/event':      { mode: 'emit';     in: SessionEvent }
  'telemetry/flush':    { mode: 'parallel'; in: void }
  'tools/post-execute': { mode: 'serial';   in: ExecResult }
}
```

派发点只能对声明了对应 mode 的事件调用 `waterfall`/`parallel`/`serial`；类型系统在编译期拦下「用错模式」。这与 Cordis 的 `@mode` 标注一致，但用 TypeScript 类型实现而非运行时装饰器。

### 3.2 生命周期状态机

`mount(service)` 走状态机 `INACTIVE → LOADING → ACTIVE → UNLOADING`：

- `LOADING` 中解析 `inject`，依赖未到位则挂起（记入 waiter，`provide` 时唤醒）；
- 依赖解析失败（某依赖 service 的 `apply` 抛错）→ 该 service 不激活，记录错误，不拖垮宿主；
- `UNLOADING` 逆序回滚该 service 在 `apply` 内登记的所有 `effect`。

---

## 四、会话日志单一事实源

### 4.1 现状与目标的本质区别

| | 现状 | 目标 |
|---|---|---|
| 源流 | `ContextManager.messages` 是**源**也是模型视图 | `SessionLog`（append-only，不可变）是唯一源 |
| 压缩 | `compact()` **原地丢弃**历史换摘要 | 压缩变成**投影层**，日志本体永不删除 |
| 持久化 | `SessionStore.save()` 整文件快照写压缩后的投影 | 追加写入原始 `SessionEvent`，投影即时派生 |

这是 M1 最核心的翻转：**从「存投影、毁源流」翻成「存源流、派投影」**。prompt cache 的前缀稳定性也由此自然获得——append-only 保证前缀永不重排。

### 4.2 SessionEvent 流

```ts
type SessionEvent =
  | { type: 'session/start'; at: number }
  | { type: 'user/message'; at: number; content: Message }
  | { type: 'assistant/chunk'; at: number; chunk: string }        // 原始块，保 replay 保真
  | { type: 'assistant/message'; at: number; message: Message }
  | { type: 'tool/call'; at: number; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool/result'; at: number; id: string; result: ToolResult }
  | { type: 'context/inject'; at: number; source: string; text: string }
  | { type: 'system-prompt/section'; at: number; key: string; text: string }
  // … 每新增一种模型可见输入，就新增一种事件
```

落盘格式沿用现有 `session-store.ts` 的 JSONL（`~/.mipham/sessions/<name>.jsonl`），但**从「整文件重写」改为「append 追加」**。

### 4.3 不变量：Model-visible means logged

运行时断言：凡进入某次模型请求的内容（system prompt 段、消息、工具 schema、注入的 context），**必须**能从日志重放出来。断言失败即 crash（fail-loud），而不是静默漂移。`deriveMessages(log)` 是纯函数，可独立单测。

### 4.4 消费者

`fork` / `resume` / `replay` / `transcript` / `telemetry` / `persistence` 全部派生自同一条流。测试可观测性由此落地：**给定日志 + 给定 provider 回放器，replay 即回归测试**（无需真实 API key）。

---

## 五、能力缝（seam）

一个缝 = 三角，缺一不可：

```ts
// 1. Service Definition —— 拥有 ctx.<key> 与词汇类型的抽象类（非 interface）
abstract class Filesystem {                      // 注册于 ctx.fs
  abstract read(path: string): Promise<string>
  abstract write(path: string, data: string): Promise<void>
  abstract spawn(cmd: string, args: string[]): Promise<Proc>
}

// 2. Service Provider —— 实现
class LocalFilesystem extends Filesystem { /* node:fs 实现 */ }
class RemoteSandboxFilesystem extends Filesystem { /* 远端沙箱实现 */ }

// 3. Consumer —— 注入，不 import 具体实现
const bashTool = {
  inject: ['fs'],
  apply(ctx) {
    const fs = ctx.get<Filesystem>('fs')!       // 换 provider 即换整个执行世界
    // bash 走 fs.spawn，不直接 import node:child_process
  },
}
```

**M2 的三缝映射**：

| 现有 | 升级为 seam | 定义键 |
|---|---|---|
| `ProviderRegistry` | LLM 适配缝 | `ctx.llm` |
| `createToolRegistry`（硬编码数组） | 工具注册缝 + 受控执行管道 | `ctx.tools` |
| skills registry | 技能加载缝 | `ctx.skills` |

缝的价值：`dsh` 的 `ctx.fs` 指向远端沙箱时，Bash/PTY/LSP **一起跟着走，零 fork**。咱家的 Read/Bash/LSP 同样共享一个 `ctx.fs` 提供者。

---

## 六、声明式组合（profile / bundle / patch）

运行中的 Mipham Code = 一棵从配置逐层叠起来的插件树：

```
profile（命名组合，存于 ~/.mipham/profiles/）
  ├── bundle：有序的插件行（模型适配器 / 工具 / 持久化 / 沙箱 / 审批策略 …）
  ├── bundle …
  ├── profile 的 cordis.patch.yml        ← 本 profile 的补丁
  ├── home 级 patch                       ← 用户全局补丁
  └── --patch 覆盖                        ← 命令行覆盖
```

- `profile` 声明它叠哪些 bundle、装哪些 out-of-tree 插件；
- `bundle` 是「配置行 + 要挂的代码」的分发格式；
- `patch` 按行 id 整行替换或插入新行。`mipham --dump-config` 打印真实启动的树，任意一行可被 patch 替换。

这一层收掉「版本/依赖治理」旧账：组合从代码变成声明，版本单源由 bundle 层承载，`package-info` 漂移问题归入「组合声明」而非「手改三文件」。

---

## 七、迁移策略与里程碑

### 7.1 绞杀三原则

1. **绿前绿后**——每个里程碑的测试在旧路径与新路径上都要过，才允许切掉旧路径。
2. **抽取而非设计**——内核 API 由现有代码的形状决定（`ToolContext` 已穿 `ctx`、registries 已有 `register`），不是先画一张图让 41k 行去迁就。
3. **内核只做到「能装下一片真叶子」就停**——让迁移反过来逼内核定型，不提前抛光。

### 7.2 M0 内核原语（金刚心初打）

- 交付：`apps/cli/src/vajra/` 下的 Context/Service/effect/inject/scope + 四派发 + 类型化事件契约 + 生命周期状态机。
- 验证：~50 个单测覆盖四原语 + 事件模式校验 + LIFO 回滚 + 依赖挂起/唤醒；**零迁移**，现有 1300 测试全绿。
- 种子：`apps/cli/vajra-spike.ts`（13/13 通过）是起点。

### 7.3 M1 日志归一（收「测试可观测性」旧账）

- 交付：`SessionLog`（append-only JSONL）+ `deriveMessages` 纯函数 + 运行时不变量 + fork/resume/replay 从流派生；`ContextManager` 从「源 + 破坏性压缩」降级为「投影 + 压缩视图」。
- 验证：replay 确定性测试（log → deriveMessages → 逐字节同 messages）；fork/resume 测试；「model-visible means logged」断言测试；现有测试全绿。
- **最高风险点**：动 `engine.ts` 热路径。缓解：`deriveMessages` 是纯函数，接引擎前先独立单测闭环。

### 7.4 M2 三 registry 升缝（收「编排边界」旧账）

- 交付：`ctx.llm` / `ctx.tools` / `ctx.skills` 三缝（Definition/Provider/Consumer）；工具成为可挂载 Service，加工具=挂插件不改 `index.ts`。
- 验证：「加一个工具不改 index.ts」测试；provider 换实现测试（如 `llm-replay` 回放器替真 API）；`read.ts` 的 `credentialConfig` 全局走私改为 `inject: ['credentials']`。
- **双系统漂移**：旧 registry 与新缝并存期间，靠绿前绿后纪律 + 逐缝切换压制。

### 7.5 M3 声明式组合 + agent scope（收「版本/依赖治理」旧账）

- 交付：profile/bundle/patch 分层 + `--dump-config` + per-agent scoped 注册（shadowing：scoped 工具遮蔽同名全局）。
- 验证：`--dump-config` 打印真实树；patch 一行替换测试；scope shadowing 测试；「包名/版本变更只改 bundle 一处」测试。

---

## 八、错误处理与边界

- **依赖解析失败**：某 service 的 `apply` 抛错 → 该 service 不激活、记录错误，宿主不崩；`mount` 返回的句柄可查询失败原因。
- **effect 抛错**：回滚过程任何一步抛错不中断后续逆序回滚，收集后统一上报。
- **不变量失败**：fail-loud（crash + 清晰诊断），拒绝静默漂移。
- **确定性**：`resolveSafe` 用 `realpathSync` canonical 化路径（spike 实锤），日志必须存 canonical 路径，replay 用 canonical 比较，否则「同一文件不同路径字符串」污染 replay。

---

## 九、测试策略

| 层 | 内容 | 手法 |
|---|---|---|
| 内核单测 | 四原语 + 状态机 + 事件模式校验 + LIFO 回滚 | Vitest，纯函数 + 内存断言 |
| 日志 | deriveMessages 确定性 + 不变量 + fork/resume | 给定日志 fixture → 断言投影 |
| 缝 | 加工具不改 index.ts + provider 换实现 | 挂载真实 read/bash 工具 + 替换 ctx.fs |
| 回放 | replay 即回归测试 | 日志 + llm-replay 回放器，无需真实 API key |
| 迁移护栏 | 绿前绿后 | 每里程碑旧/新路径双跑现有 1300 测试 |

---

## 十、风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| M1 动 `engine.ts` 热路径 | 高 | `deriveMessages` 纯函数先独立闭环；日志与投影并行跑一版本再切 |
| M2 双系统漂移 | 中 | 时间盒 + 逐缝切换 + 绿前绿后 |
| 内核兔子洞（打磨一年不迁移） | 中 | M0 时间盒，「装下一片真叶子即停」，迁移逼内核定型 |
| 确定性（realpathSync canonical 化） | 中 | 日志存 canonical，replay 用 canonical（§八） |
| 破坏 prompt cache 前缀稳定性 | 低 | append-only 天然保证前缀稳定，与现有 PrefixCacheTracker 互补 |

---

## 十一、成功标准

1. **M0**：`apps/cli/src/vajra/` 内核原语单测全绿，现有 1300 测试零回归。
2. **M1**：给定日志，`deriveMessages` 逐字节确定性；fork/resume/replay 全从流派生；replay 可作回归测试（无 key）。
3. **M2**：新增一个工具不改 `index.ts`（挂插件即可）；`ctx.fs` 换 provider 时 Read/Bash 零 fork 跟随。
4. **M3**：`--dump-config` 打印真实组合树；包名/版本变更只动 bundle 一处。
5. **全程**：三条 harness 旧账（测试可观测 / 编排边界 / 版本治理）逐一对账销号，`read.ts` 的全局走私被 `inject` 根治。

---

### 修订历史

| 版本 | 日期 | 变更 | 维护人 |
|---|---|---|---|
| 1.0.0 | 2026-08-15 | 初版：内核 API、日志单一事实源、能力缝、声明式组合、里程碑 0–3 | 技术委员会 |
