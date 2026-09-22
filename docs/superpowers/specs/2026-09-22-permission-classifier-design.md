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

   **限定（2026-09-22 补，别把这句当全称读）**：「同形」只在**两个消费者依赖的那些关系**上成立。`permission-config.ts:26-45` 已明载这张表**不是**全序 —— `acceptEdits` 与 `default` 是**不可比**的（前者放行 Write/Edit 而后者问，后者放行非文件的 `'self'` 工具而前者问），所以数组只承载可测的关系。CC 的 `Jo` 把 `default`/`dontAsk`/`bubble` 并列在 1 也是同一回事。`auto` 插在 `acceptEdits` 与 `bypassPermissions` 之间这一点**是可测的**（它严格宽于前者：前者只放行文件编辑、它放行任何通过分类器的东西），故这句在**该位置上**成立，不是整表同构。

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
7. **转盘标签逐字对齐 CC 的转盘数组**（2026-09-22 追加）。CC 有**两张不同的表**，混用它们正是「不完全对齐」的来源：
   - **转盘** `W`（偏移 `199238336`，恰好 4 个元素）——**用户手按 Shift+Tab 看到的那四个名字**：
     `{label:"default",symbol:"",color:"text"}` / `{label:"accept edits on",symbol:Ije,…}` / `{label:"plan mode on",symbol:$Pe,…}` / `{label:"auto mode on",symbol:Ije,…}`
   - **内部描述表** `Xo`（偏移 `172132660`，6 个键）：`default` 那格写着 `title:"Manual"` / `indicator:"manual mode"`；另一处（偏移 `79217536`）还把 `Bypass Permissions` 一并列出。**它是更大的内部枚举菜单，不是转盘。**

   我们原来的第 1 格 `手动模式` / `manual mode` **抄的是 `Xo`，不在转盘里**；第 3 格 `计划模式 / 只读` 自己加了「只读」；第 4 格 `绕过` / `bypass` 是 `Xo.bypassPermissions.shortTitle`。**逐字对齐的落地值**：

   | 格  | 模式          | en-US（= CC 原文） | zh-CN（译名，见下） |
   | :-: | ------------- | ------------------ | ------------------- |
   |  1  | `default`     | `default`          | 默认                |
   |  2  | `acceptEdits` | `accept edits on`  | 接受编辑            |
   |  3  | `plan`        | `plan mode on`     | 计划模式            |
   |  4  | `auto`        | `auto mode on`     | 自动模式            |

   **中文侧给译名、不照抄英文**：CC 对这几档**零中文**（`接受编辑`/`计划模式`/`自动模式`/`手动模式`/`绕过权限` 五个候选在本机 2.1.278 二进制里全 0 命中），没有可照抄的对象；而 `accept edits on` 这种片段英文混进中文页脚是体验退化。**对齐的承载体是「四个概念 + 顺序」**，英文侧逐字对齐，中文侧 1:1 译名。

8. **档位总数 = 5，不加 `dontAsk`**（2026-09-22 追加，用户裁定）。对齐后的形状：转盘 4 档（`default`/`acceptEdits`/`plan`/`auto`）+ 合法但不上转盘的 `bypassPermissions`。**这与 CC 的结构一致** —— `Xo` 里 `bypassPermissions` 与 `dontAsk` 都不在 `W` 里。
   CC 的第 6 档 `dontAsk` **明确不加**：它的语义是「不问、未预先批准就拒」（同表 `title:"Don't Ask"`），**而我们的 `default` 今天就是这个行为**（我们没有弹窗）。加进来等于同一行为挂两个名字，正是本次要消掉的那种混乱。
9. **档位字形也取自 `W`**（2026-09-22 追加）。两个最小化标识符的取值已在二进制里解出（偏移 `172130538`）：`$Pe="⏸"`（`⏸`）、`Ije="⏵⏵"`（`⏵⏵`）。故 CC 的每格是 `default → ""`（**空，什么都不显示**）、`acceptEdits → ⏵⏵`、`plan → ⏸`、`auto → ⏵⏵`；**我们页脚此前对每一档都硬写了 `⏵⏵`**。**已于 2026-09-22 落地**：`ui/app.tsx` 新增 `PERMISSION_GLYPHS`（穷尽 `Record<PermissionMode, string>`，漏键即编译错）+ `permissionGlyphPrefix()`，页脚改用后者（`default` 那一档连分隔空格都不留）。`bypassPermissions` 在 CC 的转盘上**没有对应格**（它的转盘 4 格、我们是 5 档）⇒ **保留** `⏵⏵`：无从对照时不动它，是最小的选择而不是新决定。**颜色 token 未映射**（`text`/`autoAccept`/`planMode`/`warning` 是 CC 的主题 token，与 Ink 的颜色名不是一套），**保留我们现有配色**并给 `auto` 一个新色 —— 已随 Step 6 定为 `magenta`（`PERMISSION_COLORS.auto`），这是同一处**已知偏离，不是遗漏**。

---

## 三、设计

### 3.1 遗留 `'auto'` 级别退役（决策 1 的第一步）

**事实**：`PermissionLevel` 里的 `'auto'`（`src/shared/types.ts`）**是半活的**——由 **20** 处工具声明 `permission: 'auto'` 与 `setRule(name,'auto')` **产出**，但 `src/` 内**没有任何代码分支读它**（`needsApproval` 只比 `'ask'`，`isBypassed` 只比 `'bypass'` 且自身无生产调用者）。它当时的意思是"放行，但没被标成 bypass"——一个无人读的区分。**这 20 处正是决策 1 的退役对象，已由 Step 1 落到 `'self'`。**（初稿写的「21 处」是错的：`rg -o "permission: 'auto'"` 把 `git.ts:243` 与 `permission-config.ts:32` 两条**注释**也算进去了；按声明行数 `rg "^\s+permission: 'self'," src/tools/` 实测 **20**。）

**改法**：级别名 `'auto'` → `'self'`，值语义一字不改。

**为什么先做这一步**：若直接把新档位命名为 `auto`，`VALID_MODES` 会开始接受 `'auto'`，于是 `new PermissionSystem('auto')` 的语义改变，而 config 里的 `permission: auto`（今天经 `setDefaultLevel` 落到 `default`，即"工具自决"）会**静默变成"LLM 决定"，即放宽**——正是 `fc5afd3a` 的缺陷形状。

**验证（已实做，2026-09-22）**：原方案这里写的是「改动前后对同一组 `(tool, input)` 跑 `check()`，输出逐项相同」—— 那句按字面**做不到**：返回值本身就从 `'auto'` 变成了 `'self'`。实际做的是三条能失败的判据：

1. **读侧复核（承重）**：`src/` 内唯一比较 `PermissionLevel` 的地方只对 `'ask'` 与 `'bypass'`，**没有一处读该字面量** ⇒ 改名在构造上不可能改变决策。这条才是关键，其余两条是兜底。
2. **归一化 diff**：把 HEAD 版本按 `'auto'`→`'self'` 归一后与工作区逐字比对，42 个改动文件里 37 个**逐字相等**，归一对不上的 5 个恰好是刻意重写注释的那几个 ⇒ 没有夹带改动。
3. **全量测试**：`251 文件 / 2960 passed + 2 skipped / 0 失败`，与改名前基线逐字相同 ⇒ 无测试因此改变结果。

### 3.2 `ALL_MODES` / `MODE_CYCLE` 拆分（决策 2）

**关键事实（易误判）**：`MODE_CYCLE` 此前**不是**转盘。转盘是 `src/ui/app.tsx:107` 里自己的一份数组（`PERMISSION_MODES`），而 `MODE_CYCLE` 全仓库只被 `src/core/permission.ts` 一处 import（喂 `VALID_MODES`），其真实身份是 `getAllowedModes()`（`src/core/permission-config.ts`）的**合法档位基集**，喂给 `clampMode()`。

**因此若直接把 `bypassPermissions` 从 `MODE_CYCLE` 拿掉**：`clampMode('bypassPermissions', …)` 找不到该档，会沿层级往下走并返回 **`acceptEdits`** ⇒ config 写 `permission: bypassPermissions` 的人被**静默降档**；`nextMode` 再也返回不了它；`forbiddenModes: ['bypassPermissions']` 变成空操作。静默、安全相关、且**现有测试全绿**。

**四处一起改（Step 2 已落地）**：

1. 新增 `ALL_MODES`（全部合法档位）。
2. `getAllowedModes()` 过滤 `ALL_MODES`，不再过滤 `MODE_CYCLE` —— 这一步才保住 `clampMode` 与 `maxAllowedMode` 正确。
3. `nextMode()` 改为取 `MODE_CYCLE ∩ getAllowedModes(...)`（读**转盘**顺序，两张表分道后 Shift+Tab 仍走同一条路）。
4. `src/core/permission.ts` 的 `VALID_MODES` 改为 `new Set(ALL_MODES)`，**不是** `new Set(MODE_CYCLE)`。

**Step 2 是纯机制拆分，行为零变化** —— 两张表当时**内容相同**（都是四档）。这带来一条必须讲清的性质：**新加的用例此刻全是绿的，它的价值在下次分道时才兑现**。故 Step 2 的验收靠**负控**而不是靠新用例变绿：

- ① **两张表被合并**（转盘去掉 `bypassPermissions` + `getAllowedModes` 改回过滤 `MODE_CYCLE`）⇒ P4b 的不动点探测报 `expected 'acceptEdits' to be 'bypassPermissions'` —— 那行断言差异**就是降档本身**。
- ② **只做前半步**（转盘变短、`getAllowedModes` 不动）⇒ P4b **保持绿**（确实没降档，拆分正在起作用），变红的是 P4 既有的 `cycles through all 4 modes` 与「未受限时的循环顺序不变」两条 ⇒ **转盘变短本身并不静默**，它被那两条钉住了。

两次负控都在 `permission-config.ts` 上做，`cp` 存档还原后 sha256 逐字相符（`6a765741…`）。

**转盘内容的改动刻意推到 Step 6**，与 `app.tsx`、`nextMode` 同一笔：Step 2 若先把 `bypassPermissions` 从 `MODE_CYCLE` 摘掉，而 `'auto'` 要到 Step 4 才成为合法档位，中间态就会是一个**三档转盘**，且 `app.tsx` 那份副本仍走四档 ⇒ 页脚与 `nextMode` 各说各话。**Step 6 一笔之内**把 `MODE_CYCLE` 改成 `['default','acceptEdits','plan','auto']` 并让 `app.tsx` import 它，转盘全程保持四档且与页脚同源。

**硬约束（用户明示）**：终端页脚上 `graft | ctx` 那两行是 `app.tsx:1305` 的 `<GraftStatusLine cwd={…} ctxPct={…} />`，与权限页脚（`:1318` 起）是**两个独立 JSX 元素**。Step 6 只动权限那一段，`GraftStatusLine` 的调用与 `graft-status.tsx` 一行不改；改完用 `git diff` 逐行核对，确认 diff 里没有任何 `GraftStatusLine` / `graft-status` / `ctxPct` 相关行。

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

- **第 2 步是兼容性保证**：所有非 `ask` 判定原样；`bypassPermissions` / `acceptEdits` / `plan` / allow 规则 / **20** 处 `permission:'self'` 工具声明的行为全部不变。
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

`check()` 的第 5 步（`modeBaseline`）**跑在第 6 步（`tool.permission`）之前**，而全仓库有 **20 处工具声明**写着 `permission: 'self'`。

- 若该 case 返回 `'mode-baseline'`：这 20 个工具**保持自动放行、分类器根本见不到它们** ⇒ `auto` 档在最要紧的地方反而比 `default` 宽，且是"半坏"而非"明显坏"。
- 返回 `'ask'`：分类器看到**每一次**调用，与 CC 的 `cVe`（`auto → classify`）一致。
- 与决策 4 不冲突：基线是 `ask`，分类器拒绝只是**保留**既有 `ask`，并未制造新拒绝。

### 3.7 子代理策略（决策 5）

`createSubAgentPermission()` 构造的是一个**新的** `PermissionSystem`，只传播 restrictions 与 deny 规则。若不处理，所有子代理（`Agent` / `Skill` / workflow / fork / `/bg`，共六处 `new SubAgent(...)`）都会静默失去分类器——即 `rules-loader` 那个失败形状。

**但默认不启用**，理由具体：

1. 子代理**无人值守**（后台 / worktree / daemon 共用路径），今天的硬拒是它唯一的闸门。
2. 成本按「被门控工具 × 子代理 × 轮次」相乘。
3. **放行没有审计通道**：`sub-agent.ts` 的闸门只有**拒绝**的通知路径，放行是无声的。**无人值守 + 无声放行是最坏的组合。**

**做法**：`createSubAgentPermission()` 仅在 `agentDef.permissionMode` 解析为 `auto` 时才复制分类器——这已经是写 agent 定义的人一次明确、可审计的动作，且天然受 `maxAllowedMode` 封顶。另需为**每一处**分类器放行补一条可审计记录（见 §3.8）。

### 3.8 分类器裁决台账（落地上的一处偏离）

上一条的「补审计记录」实现为 `src/core/permission-audit.ts` —— 本机 append-only JSONL（`~/.mipham/permission-audit.jsonl`，0600），**记录点在 `PermissionSystem.resolveApproval()` 内部**，即裁决的出生地。

**为什么记在出生地而不是两个闸门上。** 两道闸门（`engine.ts` / `sub-agent.ts`）都只是消费者；记录挂在那里就是「两条路径只接一条」那族缺陷的形状，且将来第三个闸门不会有任何东西提醒你。记在出生地是**构造上**覆盖全部闸门的。

**为什么不用会话日志事件（对原计划的一处偏离）。** 起初选的是 `session-log` 的 `checker/decision` 事件（同类先例，本地 append-only、不外发、不碰遥测 allowlist 契约）。动手前实测发现**子代理根本没有 `SessionLog`** —— `SubAgent` 的构造函数里没有这个参数，六个 `new SubAgent(...)` 都不传。走会话日志就只能覆盖引擎那一半，而风险 8 的对象恰恰是子代理。要覆盖它就得新拉一条日志管线，代价远大于收益。故改为**模块级台账**：无管线、无注入点，也不给 `engine` 添新能力（因此不牵动 `daemon-capability-parity.test.ts`）。

**记什么**：`at` / `mode` / `tool` / `verdict`（分类器说了什么）/ `level`（最终落定的档位）/ `reason` / `retryable` / `denialReason`。
`verdict` 与 `level` **必须两个都记**：分类器放行走的是 `allowRuleDecision()`，组织级 `maxAllowedMode` 会在那里把它压回 `ask`。只记 `verdict` 会把「上限否决」读成「放行」，只记 `level` 会把「分类器同意但被封顶」读成「分类器拒绝」——两种单字段读法都是错的。

**不记什么**：**绝不记工具入参**。入参里有文件正文、命令行、凭据片段。这不是新的暴露面（同一次调用在会话日志里以全量入参 + 全量结果落盘，台账严格更少），但**是一条明确的边界**：「`auto` 放行了哪条 Bash」只能从分类器自己的 `reason` 里读，读不到命令原文。

**一行 = 一条裁决，不是一次执行**：`classifierCache` 命中**不写**——那时分类器根本没被咨询，写一行等于声称有一个没人做过的裁决。执行次数要问 gate 侧的指标或会话日志。

**失败姿态**：写失败**永不抛**（一次台账写失败不该掀翻一次工具调用），但第一次失败往 stderr 说一句、之后不再重复——这个模块存在的意义就是消掉「无声」，写不进去还一声不响等于把无声装了回来。

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
| 9   | 裁决台账 `permission-audit.ts` + 在 `resolveApproval` 的两处分类器出口落账（§3.8）                             | 三条负控实跑（删掉落账 / 提前到静态出口 / 提前到 `CLASSIFIABLE` 之前）各自变红                              |

**改 `bundled-skills.ts` 前先查** `test/integrity/tool-reference-integrity.test.ts` 是否守那份技能正文。

---

## 五、验证与负控

**判据（仓库既有纪律）**：仓库绿证明不了规则能触发。负控分三层，缺一层则该缺陷可静默通过。

- **Layer 1 · 接线（源码侧）**：先剥注释**与字符串字面量**（否则一句提到 `resolveApproval` 的注释就能让守卫变绿），再断言两个闸门的表达式是 `await …resolveApproval(` 且该处不再有 `needsApproval(`；并先断言枚举数 `> 0`，防空转通过。**没有这一层，分类器可以完全实现、完全单测通过、却永不接线。**
- **Layer 2 · 行为（双向 + 计数 spy）**：模式必须选**静态链判 `ask`** 的（如 `default` 档 + `permission:'ask'` 的 Bash），否则"放行 ⇒ 执行"在 `bypassPermissions` 下也成立、是空的。四条：无分类器 ⇒ 不执行；放行 ⇒ 执行且分类器**恰好被咨询 1 次**；拒绝 ⇒ 不执行且错误串含分类器理由；**静态已放行的调用 ⇒ 分类器一次都没被咨询**（钉死"非 ask 判定逐字节不变"）。计数由 `test/core/permission.test.ts` 里 `alwaysAllow()` 返回的 `asked` 记录器断言（`toHaveLength(1)` / `toEqual([])`）——**2026-09-22 订正**：本文档此前把这个记录器写成一个**全仓不存在的名字** `classifierCalls`，照着它去 grep 会得出「Layer 2 未接线」这个**错误结论**（四条断言实际都在）。
- **Layer 3 · 安全性质**：`deny` 规则不可被覆盖；`ask` 规则不可被覆盖；`maxAllowedMode: 'plan'` 下分类器放行仍为 `ask`；分类器抛错 / 超时 / 返回垃圾 ⇒ 仍 `ask`（fail-closed，**必须显式断言**，因为同仓库的 `self-critique` 是反的）；**工具入参中的 prompt 注入**不得变成放行——这是**解析器**测试，若实现是 grep 响应里有没有 `allow` 就会红。

**其他机械守卫**：

- `test/agent/sub-agent.test.ts` 用的是假 gate 对象（只有 `needsApproval`）⇒ 必须补 `resolveApproval`，否则测试里分类器被绕过而测试照样绿。
- **不要给 engine 加分类器 setter**：那会触发 `test/integrity/daemon-capability-parity.test.ts` 的强制接线要求。接缝放在 `PermissionSystem` 上并在启动处注入。**代价如实记：该守卫因此看不见遗漏，Layer 1 是必需的补充。**
- `test/integrity/permission-status-parity.test.ts` 钉死启动文件里 `buildSystemPrompt(permission.getMode())` 的**恰好 2 处**——若需第三处，要有意识地更新该守卫，不是放宽它。
- `no-floating-promises` 是 `error` ⇒ 漏一个 `await` 是 lint 失败。

**跑法**：`cd apps/cli` 再跑（从仓库根跑会因 MCP 子进程继承 cwd 产生 31 个假红）。本改动会改变测试计数，**同提交内**回填文档数字。

---

## 六、风险

| #   | 风险                                                   | 处置                                                                      |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1   | **名字碰撞**（最高概率 / 最高影响）                    | 决策 1；Step 1 独立成笔且"行为不变"可测                                   |
| 2   | **静默未接线**                                         | 只有 Layer 1 能抓                                                         |
| 3   | 分类器成为**上限旁路**                                 | §3.5 第 7 步必须走 `allowRuleDecision`                                    |
| 4   | 分类器成为**拒绝规则旁路**                             | §3.5 第 4 步必须是允许清单                                                |
| 5   | 层级表**漏项** ⇒ 组织上限整体失效（fail-open、无提示） | 显式"全员在场"断言                                                        |
| 6   | 被门控路径上的**延迟**（每次阻塞一个 LLM 往返）        | 超时要比 `self-critique` 更紧，且超时 fail-closed                         |
| 7   | **daemon 策略漂移**                                    | `DAEMON_PERMISSION_MODES` 默认保持 `'default'`，运维自行 opt-in           |
| 8   | 子代理 / 后台**无声放行**                              | 决策 5 + 每处放行补审计记录（§3.8 已落地：记在 `resolveApproval` 出生地） |

---

## 七、边界（本次不做）

1. **交互式权限弹窗**——「0 学习成本」的另一半。我们的 `default` 档行为等于 CC 的 `dontAsk` 而非 CC 的 `default`，因为模型没有提问通道。本轮**不解决**，仅记录。这也意味着 `auto` 档的拒绝在体验上仍是"硬拒 + 报错"而非"转人工"。
2. **`dontAsk` 档**——CC 有而我们没有。本轮不补；它的语义已被现有 `default` 档事实承担，命名问题另议。
3. **CC 分类器的服务端变体 / sandbox-network 分类器 / telemetry 上报**——不在范围内。
