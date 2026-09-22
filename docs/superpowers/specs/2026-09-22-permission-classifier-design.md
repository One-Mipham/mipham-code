# 设计：权限分类器（`auto` 档，对齐 Claude Code）

> **日期**：2026-09-22
> **主题**：把 Claude Code 的 auto mode（LLM 权限分类器）对齐到 Mipham Code
> **状态**：设计已定，待实现
> **背景提交**：`fc5afd3a`（2026-08-25，权限档 6→4，删 `auto`/`dontAsk`）

---

## 一、问题

**目标**：与 Claude Code 完全对标，使用户 **0 学习成本**。

核查后发现，四格权限转盘里**前三格早已对齐，缺口只有第 4 格**：

| 槽  | CC Shift+Tab             | CC 行为      | Mipham 现状         | Mipham 行为        |
| :-: | ------------------------ | ------------ | ------------------- | ------------------ |
|  1  | `default`（别名 manual） | **弹窗询问** | `default`           | **硬拒**（无弹窗） |
|  2  | `accept edits on`        | 文件编辑放行 | `acceptEdits`       | 同                 |
|  3  | `plan mode on`           | 不执行       | `plan`              | 同                 |
|  4  | **`auto mode on`**       | **classify** | `bypassPermissions` | allow              |

英文标签对照（`src/i18n-core/locales/en-US.json:804-807`）：第 2 格与 CC **逐字相同**，第 3 格仅多一个 `/ read-only` 限定语，第 1 格 `manual mode` 用的是 CC 自己的别名。**唯一实质性缺口在第 4 格：我们把 CC 的分类器换成了无条件放行。**

### CC 侧证据（CC 2.1.270 二进制）

| 事实                                    | 位置                                                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shift+Tab 转盘**恰好四格**              | 偏移 `191878164`：`[{label:"default"},{label:"accept edits on"},{label:"plan mode on"},{label:"auto mode on"}]`                                                                                                                       |
| `manual` 是 `default` 的别名            | `165143001`：`kI="manual"; function Hf(e){return e==="manual"?"default":e}`                                                                                                                                                           |
| 模式→行为核心                           | `165206571`：`auto → "classify"`；`bypassPermissions → "allow"`；`dontAsk → "deny"`；其余 `"ask"`                                                                                                                                     |
| CC 自己的宽严梯子                       | `165205145`：`{plan:0, bubble:1, default:1, dontAsk:1, acceptEdits:2, auto:3, bypassPermissions:4}`                                                                                                                                   |
| 引擎故障 fail-closed                    | `171947105`：`'automode-unavailable'`（the classifier was unreachable and the call was **held back fail-closed** — NOT a policy decision; **retrying is appropriate**），`'automode-parsing-error'`（响应无法解析，同样 fail-closed） |
| `automode-blocked` = 分类器**主动否决** | 同上                                                                                                                                                                                                                                  |
| `bypassPermissions` 不在转盘内          | 偏移 `78013449`：需 `allowDangerouslySkipPermissions` 才生效                                                                                                                                                                          |
| `dontAsk` 语义                          | 同上原文：_Don't prompt for permissions, **deny if not pre-approved**_                                                                                                                                                                |

**两条推论：**

1. **我们的 `default` 档行为等于 CC 的 `dontAsk`**（CC 原文 "deny if not pre-approved"），而非 CC 的 `default`（"prompts for dangerous operations"）—— 因为我们没有弹窗。这是「0 学习成本」至今未达成的另一半原因（**本文档不解决这一半**，仅记录）。
2. **CC 的宽严梯子与我们的 `PERMISSION_MODE_HIERARCHY` 同形**，CC 只是在 `acceptEdits` 与 `bypassPermissions` 之间多插了一个 `auto`。因此「加 `auto` 档」在架构上是**填空**，不是改造。

### 历史的教训（不可重犯）

`fc5afd3a` 删除 `auto` 的直接起因是**同名不同义**：config 里的 `permission: auto`（3 档时代的"工具自决"）被 `setDefaultLevel` 映射到 6 档时代的 `auto`（"全自动执行"），用户启动即落入静默改文件。本次要把 `auto` 请回来，**必须先把那个名字腾干净**（决策 1）。

---

## 二、已裁定的决策

1. **命名**：先把遗留级别 `'auto'` 退役为 `'self'`（**行为不变**，见 §三），再让新模式占用 `auto`。**分两笔提交。**
2. **转盘完全对标 CC**：`MODE_CYCLE = ['default','acceptEdits','plan','auto']`；`bypassPermissions` 退出转盘，但**仍是合法档位**（可由 config / `MIPHAM_DAEMON_PERMISSION` / settings 进入）。
3. **规则口径 = CC 形三段式**：`hard_deny` / `soft_deny` / `allow`，**未命中即放行**；引擎故障 fail-closed。
4. **只可自动放行，不可否决**：分类器只能把静态链判定的 `ask` 变成放行，**不得制造原本不存在的拒绝**。
5. **子代理默认不启用分类器**，按 agent 定义 opt-in。
6. **默认档位不变**（`config/defaults.ts` 已是 `'default'`）⇒ 不主动切到 `auto` 档的人，行为零变化。

---

## 三、设计

### 3.1 遗留 `'auto'` 级别退役（决策 1 的第一步）

**事实**：`PermissionLevel` 里的 `'auto'`（`src/shared/types.ts`）**是半活的**——由 21 处工具声明 `permission: 'auto'` 与 `setRule(name,'auto')` **产出**，但 `src/` 内**没有任何代码分支读它**（`needsApproval` 只比 `'ask'`，`isBypassed` 只比 `'bypass'` 且自身无生产调用者）。它今天的意思是"放行，但没被标成 bypass"——一个无人读的区分。

**改法**：级别名 `'auto'` → `'self'`，值语义一字不改。

**为什么先做这一步**：若直接把新档位命名为 `auto`，`VALID_MODES` 会开始接受 `'auto'`，于是 `new PermissionSystem('auto')` 的语义改变，而 config 里的 `permission: auto`（今天经 `setDefaultLevel` 落到 `default`，即"工具自决"）会**静默变成"LLM 决定"，即放宽**——正是 `fc5afd3a` 的缺陷形状。

**验证（必须可测）**：改动前后对同一组 `(tool, input)` 跑 `check()`，输出逐项相同。

### 3.2 `ALL_MODES` / `MODE_CYCLE` 拆分（决策 2）

**关键事实（易误判）**：`MODE_CYCLE` **不是**转盘。转盘是 `src/ui/app.tsx` 里自己的一份数组。`MODE_CYCLE` 全仓库只被 `src/core/permission.ts` 一处 import，其真实身份是 `getAllowedModes()`（`src/core/permission-config.ts`）的**合法档位基集**，喂给 `clampMode()`。

**因此若直接把 `bypassPermissions` 从 `MODE_CYCLE` 拿掉**：`clampMode('bypassPermissions', …)` 找不到该档，会沿层级往下走并返回 **`acceptEdits`** ⇒ config 写 `permission: bypassPermissions` 的人被**静默降档**；`nextMode` 再也返回不了它；`forbiddenModes: ['bypassPermissions']` 变成空操作。静默、安全相关、且**现有测试全绿**。

**必须四处一起改**：

1. 新增 `ALL_MODES`（全部合法档位）。
2. `getAllowedModes()` 过滤 `ALL_MODES`，不再过滤 `MODE_CYCLE` —— 这一步才保住 `clampMode` 与 `maxAllowedMode` 正确。
3. `nextMode()` 改为取 `MODE_CYCLE ∩ getAllowedModes(...)`。
4. `src/core/permission.ts` 的 `VALID_MODES` 改为 `new Set(ALL_MODES)`，**不是** `new Set(MODE_CYCLE)`。

同时让 `app.tsx` 改为 import `MODE_CYCLE`，去掉会漂移的副本。

### 3.3 分层：`auto` 在层级表里的位置

插入 `acceptEdits` 与 `bypassPermissions` 之间 —— 即 CC 的 `zo` 排序：

```
['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']
```

**必须显式断言每个 `PermissionMode` 成员都在层级表中在场**：漏一个 ⇒ `indexOf` 返回 `-1` ⇒ 上限判断的 `if (capIdx >= 0)` 使**整个组织级上限静默失效**（fail-open）。`permission-config.ts` 已记录过这一形态。既有测试只抓得到"顺序错"，抓不到"缺失"。

### 3.4 新模块 `src/core/permission-classifier.ts`

结构照抄既有先例 `src/core/self-critique.ts`（仓库里已有一个"工具执行前调 LLM"的接缝）：prompt 构建 + JSON 抽取 + `AbortController` + 超时。

```ts
export interface ClassifierVerdict {
  allow: boolean
  reason?: string
  /** 引擎故障导致的"拿住"，非策略决定 ⇒ 应告知模型可重试 */
  retryable?: boolean
}

export interface PermissionClassifier {
  readonly version: string
  classify(req: {
    tool: string
    input: Record<string, unknown>
    mode: PermissionMode
    reason: PermissionDenialReason
    signal?: AbortSignal
  }): Promise<ClassifierVerdict>
}

export class LlmPermissionClassifier implements PermissionClassifier {
  /* 走 Llm 接口 */
}
```

**失败策略必须与 `self-critique` 相反**：`self-critique` 失败时 **fail-open**（可用性优先）；分类器**必须 fail-closed**（超时 / 抛错 / 解析失败 ⇒ `allow:false`）。该差异要写成代码注释说明"不是不一致，是刻意相反"，否则将来会有人来"修一致性"。

**规则资产**：CC 形三段式，逐字移植 CC 的保护条（Irreversible Local Destruction / Instruction Poisoning / Auto-Mode Bypass / Credential Exploration / Data Exfiltration / Logging Audit Tampering 等）。资产随代码版本化并带 `PROMPT_VERSION`。prompt 内需有显式的**不可信内容条款**——工具入参可能来自抓取的网页正文、MCP 结果、转发的子代理消息；`self-critique.ts` 已有同类条款可参照。

因为「未命中即放行」，**该资产是安全关键件**：它是 `auto` 档唯一的阻止面。

### 3.5 接缝：`PermissionSystem.resolveApproval()`

```ts
async resolveApproval(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
): Promise<ApprovalDecision>

interface ApprovalDecision {
  level: PermissionLevel
  source: 'static' | 'classifier'
  denialReason?: PermissionDenialReason
  classifierReason?: string
  retryable?: boolean
}
```

算法 —— **顺序即安全契约**：

```
1  level = this.check(tool, input)                     // 同步、带缓存、一行不改
2  if (level !== 'ask') → 原样返回，source='static'      // ← 兼容性保证
3  { reason } = this.explainDenial(tool, input)
4  if (!CLASSIFIABLE.has(reason)) → 原样 'ask'           // ← 允许清单，不是拒绝清单
5  if (!this.classifier || this.mode !== 'auto') → 原样 'ask'
6  v = await className.classify(...)
7  v.allow → { level: this.allowRuleDecision(tool, input), source:'classifier' }
8  else     → { 'ask', source:'classifier', denialReason:'classifier-deny', … }
```

承重细节：

- **第 2 步是兼容性保证**：所有非 `ask` 判定原样；`bypassPermissions` / `acceptEdits` / `plan` / allow 规则 / 21 处 `permission:'auto'`（退役后为 `'self'`）工具声明的行为全部不变。
- **第 4 步必须是允许清单**：`CLASSIFIABLE = new Set(['mode-baseline','tool-default','system-default'])`。若放行 `deny-rule` / `ask-rule` 产生的 `ask`，分类器即成为**绕开全部组织级拒绝规则的万能通道**。`legacy-rule` 也刻意排除（`setRule(name,'ask')` 同时写入 `askRules`，会以 `ask-rule` 形态出现，排除它零成本且更保守）。
- **第 7 步复用 `allowRuleDecision()`**：该方法注释已论证"规则是权限来源，跳过上限是同一缺陷往里一层"。复用 ⇒ 分类器**永不强于一条 allow 规则**，且 `maxAllowedMode` 自动封顶。**绝不可写裸的 `return 'bypass'`**。
- **新增 `PermissionDenialReason = 'classifier-deny'`**，且**必须区分两种拒绝**：策略拒绝（终局）vs 引擎故障拿住（可重试）。理由串要如实说明可重试，否则模型会以为被否决而放弃——这是 CC 明确区分的事。
- **`needsApproval()` 保持同步、保持原义**，**不要**改成去调 `resolveApproval`。它返回 boolean，而两个调用点需要完整 `ApprovalDecision`。这是最容易被误接的一处。
- **缓存**：按与 `checkCache` 同键加 `classifierCache`，并入既有 `invalidateCache()`。

### 3.6 行为开关：`modeBaseline` 的 `auto` case 必须返回 `'ask'`

```
case 'auto':
  return 'ask'      // 承重
```

`check()` 的第 5 步（`modeBaseline`）**跑在第 6 步（`tool.permission`）之前**，而全仓库有 **21 处工具声明**写着 `permission: 'auto'`（退役后 `'self'`）。

- 若该 case 返回 `'mode-baseline'`：这 21 个工具**保持自动放行、分类器根本见不到它们** ⇒ `auto` 档在最要紧的地方反而比 `default` 宽，且是"半坏"而非"明显坏"。
- 返回 `'ask'`：分类器看到**每一次**调用，与 CC 的 `cVe`（`auto → classify`）一致。
- 与决策 4 不冲突：基线是 `ask`，分类器拒绝只是**保留**既有 `ask`，并未制造新拒绝。

### 3.7 子代理策略（决策 5）

`createSubAgentPermission()` 构造的是一个**新的** `PermissionSystem`，只传播 restrictions 与 deny 规则。若不处理，所有子代理（`Agent` / `Skill` / workflow / fork / `/bg`，共六处 `new SubAgent(...)`）都会静默失去分类器——即 `rules-loader` 那个失败形状。

**但默认不启用**，理由具体：

1. 子代理**无人值守**（后台 / worktree / daemon 共用路径），今天的硬拒是它唯一的闸门。
2. 成本按「被门控工具 × 子代理 × 轮次」相乘。
3. **放行没有审计通道**：`sub-agent.ts` 的闸门只有**拒绝**的通知路径，放行是无声的。**无人值守 + 无声放行是最坏的组合。**

**做法**：`createSubAgentPermission()` 仅在 `agentDef.permissionMode` 解析为 `auto` 时才复制分类器——这已经是写 agent 定义的人一次明确、可审计的动作，且天然受 `maxAllowedMode` 封顶。另需为**每一处**分类器放行补一条可审计记录。

---

## 四、分步实施

| 步  | 内容                                                                                                           | 验证                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0   | 本文档入库                                                                                                     | —                                                                                                           |
| 1   | 退役遗留级别 `'auto'` → `'self'`（独立提交）                                                                   | 改动前后 `check()` 对同一组输入逐项相同                                                                     |
| 2   | 拆 `ALL_MODES` / `MODE_CYCLE`（独立提交）                                                                      | `clampMode('bypassPermissions', undefined)` 仍返回自身；`forbiddenModes` 仍生效；`nextMode` 永不返回 bypass |
| 3   | `permission-classifier.ts`                                                                                     | **同一提交内**登记进 `stryker.config.json` 的 `mutate`，否则 `test/integrity/mutation-wiring.test.ts` 会红  |
| 4   | `resolveApproval()` + `modeBaseline` 的 `auto` case                                                            | 含 §五 Layer 3 全部安全性质                                                                                 |
| 5   | 接线 `engine.ts` / `sub-agent.ts` 两个闸门                                                                     | 阻断计数语义不变；子代理默认仍硬拒                                                                          |
| 6   | 转盘 / 标签 / i18n（两份 locale）                                                                              | `PERMISSION_COLORS` / `PERMISSION_LABELS` 是穷尽 `Record`，漏键即编译错                                     |
| 7   | `instructions.ts` 的 `modeDescriptions`、`commands/project.ts`、`agent/types.ts`、`permission.ts` 的 `modeMap` | 漏键 ⇒ 系统提示对权限什么都不说                                                                             |
| 8   | 守卫与负控（§五）                                                                                              | —                                                                                                           |

**改 `bundled-skills.ts` 前先查** `test/integrity/tool-reference-integrity.test.ts` 是否守那份技能正文。

---

## 五、验证与负控

**判据（仓库既有纪律）**：仓库绿证明不了规则能触发。负控分三层，缺一层则该缺陷可静默通过。

- **Layer 1 · 接线（源码侧）**：先剥注释**与字符串字面量**（否则一句提到 `resolveApproval` 的注释就能让守卫变绿），再断言两个闸门的表达式是 `await …resolveApproval(` 且该处不再有 `needsApproval(`；并先断言枚举数 `> 0`，防空转通过。**没有这一层，分类器可以完全实现、完全单测通过、却永不接线。**
- **Layer 2 · 行为（双向 + 计数 spy）**：模式必须选**静态链判 `ask`** 的（如 `default` 档 + `permission:'ask'` 的 Bash），否则"放行 ⇒ 执行"在 `bypassPermissions` 下也成立、是空的。四条：无分类器 ⇒ 不执行；放行 ⇒ 执行且 `classifierCalls === 1`；拒绝 ⇒ 不执行且错误串含分类器理由；**静态已放行的调用 ⇒ `classifierCalls === 0`**（钉死"非 ask 判定逐字节不变"）。
- **Layer 3 · 安全性质**：`deny` 规则不可被覆盖；`ask` 规则不可被覆盖；`maxAllowedMode: 'plan'` 下分类器放行仍为 `ask`；分类器抛错 / 超时 / 返回垃圾 ⇒ 仍 `ask`（fail-closed，**必须显式断言**，因为同仓库的 `self-critique` 是反的）；**工具入参中的 prompt 注入**不得变成放行——这是**解析器**测试，若实现是 grep 响应里有没有 `allow` 就会红。

**其他机械守卫**：

- `test/agent/sub-agent.test.ts` 用的是假 gate 对象（只有 `needsApproval`）⇒ 必须补 `resolveApproval`，否则测试里分类器被绕过而测试照样绿。
- **不要给 engine 加分类器 setter**：那会触发 `test/integrity/daemon-capability-parity.test.ts` 的强制接线要求。接缝放在 `PermissionSystem` 上并在启动处注入。**代价如实记：该守卫因此看不见遗漏，Layer 1 是必需的补充。**
- `test/integrity/permission-status-parity.test.ts` 钉死启动文件里 `buildSystemPrompt(permission.getMode())` 的**恰好 2 处**——若需第三处，要有意识地更新该守卫，不是放宽它。
- `no-floating-promises` 是 `error` ⇒ 漏一个 `await` 是 lint 失败。

**跑法**：`cd apps/cli` 再跑（从仓库根跑会因 MCP 子进程继承 cwd 产生 31 个假红）。本改动会改变测试计数，**同提交内**回填文档数字。

---

## 六、风险

| #   | 风险                                                   | 处置                                                            |
| --- | ------------------------------------------------------ | --------------------------------------------------------------- |
| 1   | **名字碰撞**（最高概率 / 最高影响）                    | 决策 1；Step 1 独立成笔且"行为不变"可测                         |
| 2   | **静默未接线**                                         | 只有 Layer 1 能抓                                               |
| 3   | 分类器成为**上限旁路**                                 | §3.5 第 7 步必须走 `allowRuleDecision`                          |
| 4   | 分类器成为**拒绝规则旁路**                             | §3.5 第 4 步必须是允许清单                                      |
| 5   | 层级表**漏项** ⇒ 组织上限整体失效（fail-open、无提示） | 显式"全员在场"断言                                              |
| 6   | 被门控路径上的**延迟**（每次阻塞一个 LLM 往返）        | 超时要比 `self-critique` 更紧，且超时 fail-closed               |
| 7   | **daemon 策略漂移**                                    | `DAEMON_PERMISSION_MODES` 默认保持 `'default'`，运维自行 opt-in |
| 8   | 子代理 / 后台**无声放行**                              | 决策 5 + 每处放行补审计记录                                     |

---

## 七、边界（本次不做）

1. **交互式权限弹窗**——「0 学习成本」的另一半。我们的 `default` 档行为等于 CC 的 `dontAsk` 而非 CC 的 `default`，因为模型没有提问通道。本轮**不解决**，仅记录。这也意味着 `auto` 档的拒绝在体验上仍是"硬拒 + 报错"而非"转人工"。
2. **`dontAsk` 档**——CC 有而我们没有。本轮不补；它的语义已被现有 `default` 档事实承担，命名问题另议。
3. **CC 分类器的服务端变体 / sandbox-network 分类器 / telemetry 上报**——不在范围内。
