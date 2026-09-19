# 定向安全审计 → 加固计划（2026-09-19）

> **基线**: `mipham-code` `e49d2cd`（== `origin/main`），工作树干净，233 测试文件 / 2702 测试，
> CLI 包版本 0.81.8，运行时 bun 1.3.14 / darwin arm64。
> **性质**: 上一份加固计划（`2026-09-18-security-and-correctness-hardening.md`，27 条）**已全部关闭**
> （2.51.0–2.58.0）。本计划是**新的一轮审计**的产物，不是那份计划的续篇。
> **审计规模**: 4 个面（凭据落盘 / 权限层模式降级 / daemon 外部 API / 命令执行机制），
> 4 个只读探针子代理，artifacts 在 `/tmp/audit-p6/`。**审计期间未改动仓库任何文件。**

---

## 〇、审计边界与已知已关（防止拿旧账当新缺口）

### 不在本计划内（已核实非缺口 / 已关 / 已决定不做）

| 事项                                                                               | 处置                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 上一份计划 27 条（含 deny 规则匹配器族，已审四轮）                                 | **全部已关**，落点见 `docs/claude-md-history.md`              |
| daemon CSRF / loopback 绕过                                                        | 已修 2026-09-14；本轮**只验是否仍成立**（结论：成立，见 §三） |
| `bash -c 'cat secret'` 绕过 `Read()`                                               | 旧记录过时，**已修**                                          |
| rewind 零填充 / macOS 双路径 / `.git/info/exclude` / Edit 预览行号 / markdown 渲染 | 上一份计划「不做」表，已核实 N/A                              |
| E2E CI 全跳、`get_vault_info` 第三方 bug                                           | 已决定不排期 / 等上游                                         |
| `apps/telemetry/`                                                                  | 独立工作区，不在四面内                                        |

### 本轮的增量前提（一句话）

deny 规则的**匹配**已被审四轮；增量在**没查过的面**：`enc:v1:` 凭据落盘路径、
permission 层**模式降级**（不是匹配）、daemon **外部 API**、命令的**执行机制**（不是匹配）。

### 证据等级约定

- **实测** —— 有能翻转的对照（对象错时它会红）
- **读码** —— 回源码逐行确证
- **读码 + 探针** —— 源码确证 + 找到过反例，但**无可达路径**（如实降级，不冒充实测）

> **铁律（沿用上一份计划）**：**不留只读码结论**。每一项的验收必须是「改动前红、改动后绿」，
> 且必须配一个**能失败的对照** —— 判据要能回答「如果对象是错的，它会不会红？」。
> 只读码判定的项，必须写明「为什么当前不可达」。

---

## 一、缺口清单

**复验列**说明：✅ = 我（主会话）独立回源码或实测复验过；⚠️ = 仅子代理报告，未独立复验。
本计划**只把 ✅ 的项排进批次**。

### D 族 — daemon 外部 API

| #      | 缺口                                                                                                                                                                                                                                                                                                     | 严重度   | 复验                                                            | 坐标                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| **D1** | `verifyToken` 调 `Bun.password.constantTimeCompare` —— **该函数在 bun 1.3.14 不存在**（`Object.keys(Bun.password)` = `hash/hashSync/verify/verifySync`）。任何带 `Authorization` 的远程请求（**含正确 token**）抛 TypeError → 500。令牌鉴权在唯一需要它的配置（`MIPHAM_BIND=0.0.0.0`）下 100% 不工作     | **HIGH** | ✅ 实测                                                         | `src/daemon/auth.ts:40-46`，调用点 `:103`            |
| **D2** | 该 500 是 Bun 的**开发错误页**（真 bun 实测：关 flag 时响应体 **67,154 字节 HTML 应用**，开 flag 时 **21 字节纯文本**）⇒ 未认证对端拿到的是一个自带 JS 的开发者调试 UI。**未证**：overlay 会把源码交回（overlay 的 Accept / 磁盘路径猜测 / `/bun:info` 三路探针均未取回抛出文本）—— 按实测改写，不按推断 | MEDIUM   | ✅ 实测（真 bun 探针）                                          | `src/daemon/server.ts:362-368`                       |
| **D3** | `POST /api/v1/auth/rotate` **不轮换任何东西**：旧 token 继续 200，而 API 刚发出去的新 token 被 403                                                                                                                                                                                                       | MEDIUM   | ✅ 读码（`token` 是解构出的 **const**，结构上不可能被重新赋值） | `src/daemon/server.ts:124-141` / `:400` / `:692-695` |
| **D4** | `/feishu/event` 的 `return` 在 `originMiddleware` 与限流器**之前** ⇒ 该路由不受源闸与限流管（Lark 签名闸本身有效，属**控制旁路**不是鉴权旁路）                                                                                                                                                           | LOW–MED  | ✅ 读码                                                         | `src/daemon/server.ts:375-378` vs `:384/:388`        |
| **D5** | `{mode:0o600}` 只在**创建**时生效；已存在的宽松 token 文件不会被 rotate/load 收紧                                                                                                                                                                                                                        | LOW      | ⚠️ 实测                                                         | `src/daemon/auth.ts:51-55`                           |
| **D6** | 不可解析的 `cronExpr` **静默**变成「每分钟触发一次」，而非 400 ⇒ 持久化的、攻击者可控形状的 prompt 每分钟过一遍引擎                                                                                                                                                                                      | LOW      | ⚠️ 读码+实测                                                    | `src/core/cron.ts:12-14`，`server.ts:667`            |

### C 族 — `enc:v1:` 凭据落盘

| #      | 缺口                                                                                                                                                                        | 严重度                 | 复验                                                                         | 坐标                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **C1** | 首次创建 `.cred-key` 是 `existsSync`→`randomBytes`→`writeFileSync`，**无 `O_EXCL`** ⇒ 两个首用调用方各自生成密钥，后者覆盖前者；**败者用它那把写下的密文永久无法解出**      | MEDIUM                 | ✅ 读码（可达性已验：daemon 走 `loadConfig`，而首启会 detached 拉起 daemon） | `src/config/credential-crypto.ts:57-66`                                                                      |
| **C2** | `decryptProviderApiKeys` 对**非字符串** `apiKey` 裸调 `.startsWith` ⇒ **启动崩溃**。**同文件的兄弟读取器有 typeof 守卫**，这条没有 ⇒ 不变式已写在代码里，只是没施加到这一处 | MEDIUM                 | ✅ 读码                                                                      | `src/config/loader.ts:607`/`:611` vs `:640`；`mergeProviders` 的 `op.id` 对 `providers:[null]` 同族（`:68`） |
| **C3** | 密钥文件先按 `0666 & ~umask` 裸写、再**另一次** chmod ⇒ 窗口内可读；且中途死掉后 `:58-59` 只回读**不补 chmod** ⇒ **永久 0644**                                              | LOW–MED                | ✅ 读码                                                                      | `src/config/credential-crypto.ts:63-64` vs `:58-59`                                                          |
| **C4** | 由密钥路径创建 `~/.mipham` 时是 **0755**，而 `loader.ts:663` 是 0700 ⇒ 目录模式取决于**哪条路先碰它**                                                                       | LOW                    | ✅ 读码                                                                      | `src/config/credential-crypto.ts:62`                                                                         |
| **C5** | 密钥与密文**同目录**（都是 `~/.mipham`）                                                                                                                                    | **INFO（上限非缺口）** | ✅ 读码                                                                      | `credential-crypto.ts:42` / `loader.ts:660`                                                                  |

> **C5 为何不算缺口**：同 uid 的攻击者本来就能读 `~/.mipham/`。加密真正防的是
> 「`config.yml` 被复制/截图/提交/贴进 issue」，而那正是它挡住的东西（同 uid ⇒ 游戏本来就结束了）。
> 换 OS 钥匙串 = 引新依赖 + 跨平台工程，与「简洁优先／不引入新依赖」冲突。**本计划不动它。**

### P 族 — 权限层（模式降级，不是匹配）

| #      | 缺口                                                                                                                                                                                            | 严重度  | 复验                     | 坐标                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------ | ------------------------------------------------------------------------------------ |
| **P1** | `permissionRestrictions` 值写错（错拼/错大小写/类型不对/标量）⇒ **静默地整条策略失效**，无任何警告；而**写错的规则**会通过 `getInvalidRules()` 警告 ⇒ 同一个失败，两条通道待遇不同              | MEDIUM  | ✅ 读码                  | `src/core/permission-config.ts`（`getAllowedModes` / `isModeAllowed` / `clampMode`） |
| **P2** | 模式上限**管不住 allow 规则通道**：命中 allow 规则即 `bypass`，**早于**模式基线。通道包括随仓库下发的 `<cwd>/.mipham/settings.json permissions.allow` 与项目 `config.yml permissionRules.allow` | MEDIUM  | ✅ 读码                  | `src/core/permission.ts`（`check()` 第 3 步 / `allow()`）                            |
| **P3** | 状态行与执行不一致，且偏**放宽**方向（clamp 后 UI 存的是未钳制值；启动时 `permission: bypass` 生效而页脚显示 default）                                                                          | 读码    | ✅ 读码                  | `src/ui/app.tsx:1248-1258`                                                           |
| **P4** | `plan` 在层级里排在 `acceptEdits` **之上**，实际却更严；`getAllowedModes`/`isModeAllowed` **零消费者**                                                                                          | LOW–MED | ✅ 读码                  | `src/core/permission-config.ts` 的 `PERMISSION_MODE_HIERARCHY`                       |
| **P5** | 系统提示收到的是 `config.permission` **原始值**，从不是钳制后的模式                                                                                                                             | LOW     | ✅ 读码                  | 系统提示组装处                                                                       |
| **P6** | `SubAgent` 的 `permission === undefined` 时**每个工具都执行**（fail-open 已证）；但**未找到活的产出路径**                                                                                       | LOW     | ✅ 读码 + 探针（无路径） | `src/agent/sub-agent.ts:469` 的 `?.`                                                 |
| **P7** | 限制住在**用户自己的** `~/.mipham/config.yml` 里 ⇒ 是「用户自律」不是 admin 边界（注释里的 "org-level" 说过头了）                                                                               | INFO    | ✅ 读码                  | 同上                                                                                 |
| **P8** | `config.yml permission: bypass` 有效，但**当前拼写 `bypassPermissions` 映射到 default**；未知/遗留值完全不产出权限上下文                                                                        | INFO    | ✅ 读码                  | `permission.ts` `setDefaultLevel`                                                    |

### E 族 — 命令**执行机制**

| #      | 缺口                                                                                                                                                                 | 严重度  | 复验                                                                                                                                                                                         | 坐标                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **E4** | `Git` 是 `permission:'auto'`（**无需审批**）且 **spawn 无超时**，argv 由模型 token 拼；`--upload-pack=<cmd>` 执行本地程序 ⇒ **同一台机器上 Bash 要审批、这条路不用** | MEDIUM  | ✅ 读码 + 子代理有能翻转的对照                                                                                                                                                               | `src/tools/exec/git.ts:151` / `:166-174`（匹配的是**原始字符串**）/ `:187-191`           |
| **E1** | daemon 路径给 Bash 的 registry **掩码禁用**（`DISABLED_CREDENTIAL_MASKING_CONFIG`）⇒ 子进程继承全量 `process.env`（含各家 API key 与 bot secret），且输出不擦洗      | MEDIUM  | ✅ 读码 + **我补**：workflow 那条**已被 `runtime.ts:133-135` 关掉**（先 spread `...opts` 再覆盖 `permissionSystem`，脚本无法绕过），只剩 daemon；且 daemon 默认模式对 `ask` 工具 fail-closed | `src/tools/index.ts:36-45`、`src/daemon/server.ts:208`、`src/tools/exec/bash.ts:393-404` |
| **E2** | 项目 `.mipham/config.yml` 可设 `credential_masking.enabled:false`（代码注释自己写着 "project wins (loaded last)"）⇒ 连 CLI 路径的 env 过滤与输出擦洗一起关掉         | MED–LOW | ✅ 读码                                                                                                                                                                                      | `src/config/loader.ts:500-536`                                                           |
| **E3** | 超时只 `proc.kill()` 直接子进程：**孙进程存活**（已孤儿化，无通知）；且**持管道时调用永不返回** —— 因为读 stdout 在 `await proc.exited` **之前**                     | MEDIUM  | ✅ 读码                                                                                                                                                                                      | `src/tools/exec/bash.ts:406-409`                                                         |
| **E5** | `EnterWorktree.baseRef` **未校验** ⇒ 落进 git 的选项命名空间（`-b`/`--detach` 被当选项解析，`--force` 被接受）；`git worktree add` 子命令内无命令执行原语            | LOW     | ⚠️ 实测                                                                                                                                                                                      | `src/tools/exec/enter-worktree.ts:31` / `:129`                                           |
| **E6** | env 过滤按**名字后缀**匹配：`*_IDS`（含 daemon 自己的频道白名单）、`DATABASE_URL`、`GH_PAT` 放行；输出擦洗需要 `name=value` 形状（裸值 / JSON 形状不擦）             | LOW     | ⚠️ 实测                                                                                                                                                                                      | `src/config/defaults.ts:73-78`                                                           |
| **E7** | 执行路径的**错误归因错**：不存在的 cwd 报成 `posix_spawn 'bash'` ENOENT（说成「bash 没装」）、`timeout:-1` 报成 `Exit code 143`                                      | LOW     | ✅ 读码                                                                                                                                                                                      | `src/tools/exec/bash.ts:462-468`、`:406`                                                 |
| **E8** | worktree 逃逸守卫是**字符串**比对（别名 cwd 可绕过，探针已红）；`ExitWorktree` 用 `process.cwd()` 校验却以 `ctx.cwd` 执行，且第 67 行对**原始**参数用 `includes`     | LOW     | ⚠️ 读码 + 探针（未找到路径）                                                                                                                                                                 | `src/tools/exec/bash.ts:327-340`、`src/tools/exec/exit-worktree.ts:42-43,67`             |

### N 族 — 审计中追出的一条前提（**未决，需另行裁定**）

| #      | 事实                                                                                                                                                                                                                                                                                                                                                     | 坐标                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **N1** | 项目 `<cwd>/.mipham/settings.json` 的 `hooks` **零校验**直接进 `spawnSync(cfg.command, args)`（全量继承 env）。唯一的闸是工作区信任询问，而它 **① 只在 `index.tsx:318` 一处、② 非 TTY 时直接 return 跳过**（`index.tsx:97-98`）；**`mipham run <script>` 与 daemon 两条路根本不调用它**（`bin/mipham.ts:24-51`；`src/daemon/engine-capabilities.ts:94`） | `src/core/hooks-config.ts:31`、`src/index.tsx:97-98/318`、`src/core/hooks-executor.ts:118` |

> **N1 的性质**：这是我在追「项目配置类缺口（C2/E2/P2）凭什么可达」时撞上的**前提**，不在原定四面内。
> 「项目级 hooks 是代码执行面」本身是沿用上游惯例的**设计**，但**非 TTY 自弃**这一条是这套设计的
> 整个要点所在（信任闸存在的理由就是「这个目录不是我写的」）。
> **已呈报**；用户于 2026-09-19 裁定「先做 N1 那条」，并选定**加载点 fail-closed** + **env 一并收口**
> ⇒ 见「N1 落地状态」节（本计划原「不纳入」的表述已随之作废）。

---

## 二、执行批次

### 批次 1 — 止血（D1 + D2 + D3 + E4）

> **状态：✅ 已落地（2026-09-19，两笔）** —— `f9a6a49`（D1+D2+D3，daemon 鉴权面）、
> `851fa1a`（E4，Git 执行面），文档回填一笔另计。测试 **2702 → 2715**（文件 **233 → 234**），
> `tools` 355 → 362、`daemon` 202 → 208。`pnpm typecheck` / `pnpm lint` / `/crsi eval` 100/38 全绿。
>
> **落地时与本节原计划的三处偏差（如实记）**：
>
> 1. **D1 的修法多了一层**：不只是让 `verifyToken` 用 `timingSafeEqual` —— 还必须先把
>    `vitest.setup.ts` 的 `Bun.password` 替身改忠实（拿掉它凭空补上的 `constantTimeCompare`）。
>    **只改替身、源码一字不动即当场 5 红**，其中两条是 `authMiddleware` 的用例 ⇒ 被藏住的不止
>    `verifyToken`，是中间件整层。顺序是「先改替身看它红，再改源码看它绿」。
> 2. **E4 的实测与子代理报告不一致两处**：`--upload-pack <cmd>` 的**空格形式同样生效**（子代理
>    只测了 `=` 形式）；**分页器一族经此工具不可达** —— `Bun.spawn` 总是管道、没有 TTY，
>    git 无 TTY 时不启动分页器（`--paginate` 也不触发），故 `core.pager` 那条正则是纵深防御、
>    **不是本批的活口子**。原计划把 pager 当作主要理由之一，据此下调。
> 3. **D3 的附带项按「最小、可加」实现**：CLI 只**打印一行**「运行中的 daemon 保留旧令牌直到重启」，
>    **不做主动通知**（那仍需 §四 的裁定）。这一行不是装饰 —— 没有它，用户会以为轮换已生效。
>
> **D2 的诚实边界照原样保留**：代码注释与本文都只写实测到的（67,154 字节 HTML / 21 字节纯文本），
> 「overlay 会把源码交回」**未证**，不写。

用户已明确圈定：「先摘 D1/D2 + D3 + E4」。四条的共同点是**确定性缺陷、都有现成对照**。

#### D1 — 让 `verifyToken` 真的做常数时间比较

- **落点**：`src/daemon/auth.ts:6-12`（那条**假的**注释）、`:40-46`（实现）
- **修法**：改用 `node:crypto` 的 `timingSafeEqual`（已实测在真 Bun 下可用）。
  **必须先比长度** —— `timingSafeEqual` 对不等长抛 `RangeError`。
  删掉 `PasswordWithCompare` 接口与 `as unknown as` cast（那个 cast 正是压住编译错的手），
  删掉「the method exists at Bun 1.2+ runtime」这条已被推翻的注释。
- **改动前红 / 改动后绿**：
  - 用例（**照真运行时构造**）：把 `Bun.password.constantTimeCompare` **拿掉**再断言
    `verifyToken('abc','abc') === true`。修前抛 TypeError ⇒ 红；修后 ⇒ 绿。
    **这条用例才是能抓住 D1 的那条** —— 现有 `auth.test.ts:50` 在 mock 补上函数的条件下
    **对真 Bun 不可能成立**，却一直是绿的。
  - 长度不等：`verifyToken('abc','abcd') === false`；空值：`verifyToken('','abc') === false`
- **补 CI 第二重盲区**：`vitest.setup.ts:137-140` 把每个测试请求的 `requestIP()` 钉成
  `127.0.0.1` ⇒ `auth.ts:92` 在比较**之前**就返回，**daemon 测试从不进入 auth 分支**。
  补一个把 peer 设为**非 loopback** 的用例，断言：无头 → 401；错 token → 403；对 token → 200。
  这条是端到端的闸，也是 D1 在 CI 里永远看不到的原因。

#### D2 — 关掉 daemon 的开发错误页

- **落点**：`src/daemon/server.ts:362-364` 的 `Bun.serve({ port, hostname, fetch })`
- **修法**：加 `development: false`。**不依赖用户的 `NODE_ENV`**（实测那是另一个有效杠杆，
  但让安全性取决于用户环境变量是错的形状）。
- **改动前红 / 改动后绿**：断言 `Bun.serve` 收到的配置里 `development === false`。
  修前配置里没有该键 ⇒ 红；修后 ⇒ 绿。
- **真机探针（已执行，bun 1.3.14）**：起两个 `Bun.serve`（一个不设 flag、一个 `development:false`），
  fetch 处理器抛异常，量响应体 —— **关 flag = 67,154 字节 HTML 应用；开 flag = 21 字节纯文本**
  （`Something went wrong!`）。杠杆成立，量级差 3000 倍。
- **诚实边界（已写进代码注释）**：**「overlay 会把源码交回」这条我没有证到** ——
  按 overlay 自己的 Accept 头重取失败 URL、猜磁盘路径、`/bun:info` 三路都没取回抛出文本
  （每条未匹配路径都返回同一份 shell，而 `/bun:info` 只回版本/平台）。所以理由只取实测的形状：
  一个自带 JS 的开发者调试 UI 被端给了发请求的人 —— 而不是「响应体里有源码行」。
- **单测能覆盖到的**：仅 `Bun.serve` 收到的配置里 `development === false`（mock 的 500 体是
  `{"ok":false,...}`，那份 HTML 在 Node 里根本不存在）。**不假装单测覆盖了行为面。**

#### D3 — 让 rotate 真的轮换

- **落点**：`src/daemon/server.ts:124-141`（解构出 `token`）、`:400`（用它鉴权）、`:692-695`（rotate 路由）
- **修法**：在 `createServer` 内引入 `let activeToken = token`；`:400` 改用它；
  rotate 路由内 `activeToken = newToken`。**不动 `ServerConfig` 的形状**（调用方仍传 `token`）。
- **改动前红 / 改动后绿**：起真 server → 用 T1 请求得 200 → `POST /api/v1/auth/rotate` 拿到 T2 →
  断言 **T1 → 403** 且 **T2 → 200**。修前是 T1→200 / T2→403（红），修后翻转（绿）。
- **附带（需裁定，见 §四）**：CLI 侧 `bin/mipham.ts:1035` 只改文件、**不通知在跑的 daemon**。
  ✅ **已落地（2.68.0，`9a170302`）**：按 §四 第 1 行的裁定 —— **不做**跨进程通知（那要新端点），
  改为在输出里**明说**并给出动作。提示现为「⚠️ A running daemon still ACCEPTS the old token
  until it restarts.」+「Restart it to complete rotation: `mipham daemon restart`」；
  该动作经核实为真（`launch.ts` 的 detached spawn 走 `daemon start`，其 start 分支重读
  `~/.mipham/daemon.token`，与 rotate 写的是同一路径）。行为由
  `test/daemon/auth-rotate.test.ts` 新增的 describe 钉住（CLI 那条路径：文件里旧令牌已消失，
  同一个 daemon 仍认它 200、且不认新的 403）。**裁定已闭合，不再开着。**

#### E4 — 关掉 Git 的「选项即程序」执行面 + 加超时

- **落点**：`src/tools/exec/git.ts:8-51`（清单）、`:151`（permission）、`:166-174`（**原始字符串**匹配）、`:187-191`（spawn）
- **修法（两层，**additive**，不动既有语义）**：
  1. **在 `splitCommand` 之后、spawn 之前，对 argv 判一次**：拒绝「值是一个程序、git 会去执行它」
     的选项族 —— `--upload-pack[=]`、`--receive-pack[=]`、`--exec-path[=]`；
     并把 **attached 拼写**的 config 赋值（`-ccore.pager=…`、`--config=…`）按**已有的危险键集合**一并判。
     在 **argv** 上判，顺带把「字符串 matcher 与 git 实际 argv 不一致」这条偏差也关掉。
  2. `Bun.spawn` 加超时（与 `bash.ts:406` 同形：`setTimeout` + `proc.kill()`）。
- **为什么不改 `permission: 'auto'`**：那会让每一次 `git status` 都要审批，是 UX 倒退，
  而这里真正要关的是**执行原语**本身。（写进注释，免得后人「顺手」改回去。）
- **改动前红 / 改动后绿**：
  - `ls-remote --upload-pack=/tmp/x.sh <path>` ⇒ 修前**未被拦**（红），修后**必须被拦**（绿）
  - **放行对照**：同一探针里 `ls-remote origin` 必须**放行** ⇒ 证明不是一刀切拒绝
  - **不丢既有保护的对照**：`--paginate -c core.pager=/tmp/x.sh log` ⇒ 修前**已拦**、修后**仍拦**
    ⇒ 证明 argv 层的新检查没有把既有的 config 键规则弄丢
  - 超时：**覆盖较弱，如实标注** —— `git` 没有像 `bash` 那样现成的阻塞命令好用；
    计划是先测「超时助手」（可测），接线由探针跑真 `gitTool.execute` 验。
    **若造不出确定性用例，就不假装它被测到了**。

**批次 1 的提交切分**：`D1+D2+D3` 一笔（同在 `src/daemon/`，一个主题：daemon 外部 API 的鉴权面），
`E4` 一笔（`src/tools/exec/git.ts`，独立主题、独立回滚），文档回填一笔 —— 与上一批
「代码在前、回填单独一笔」的形态一致。

---

### 批次 2 — C 族（凭据落盘）：C1 + C2 + C3 + C4

> **状态：✅ 已落地（2026-09-19，两笔）** —— `8fe01ad`（C1+C3+C4，全在 `getOrCreateKey` 这 10 行里）、
> `500abf5`（C2，config.yml 字段类型守卫），文档回填一笔另计。测试 **2715 → 2725**（文件 **234 → 235**，
> 新增 `test/config/credential-key-race.test.ts`），`config` 42 → 52。
> `pnpm typecheck` / `pnpm lint` / `prettier --check .` 全绿。
>
> **落地时与本节原计划的三处偏差（如实记）**：
>
> 1. **C1 的验收换了一法**：原写「两进程屏障」，实做是**同进程探针**（与 `test/shared/atomic-write.test.ts` 同法）——
>    同步 fs 在单进程里没法真并发，让 `existsSync` 对**本进程**谎报「不存在」、而盘上那份竞态者的密钥是真的，
>    正是落败进程眼中的世界，判据（返回值与盘上文件是否仍等于对方那把）与两进程同形且可重复。
> 2. **C3 的量法从「inode/模式序列」改成「写入当下的模式」**：原计划量 inode 序列，但本条要判的是
>    「创建那一刻模式就已经收紧」，而**函数返回后的模式**由事后 chmod 补上、恰好看不见崩在中间的那次。
>    故改在 `writeFileSync` 钩子里、落盘**当下** stat（负控：撤读取路径收紧 + mkdir mode ⇒ **恰好 2 条红**，
>    而 `wx` 那条与「写入当下即 0400」那条保持绿 —— 四个用例各自判别各自的机制）。
> 3. **C2 的判据不是原计划想的那样**：原写「非字符串值当作『没有键』处理」，我据此断言 `apiKey` 等于 `''` ——
>    **实测是错的**：回落到 provider 默认的 `${DEEPSEEK_API_KEY}`，那是**更对**的行为（字段没写本来就该回落默认）。
>    改的是**断言不是代码**，并把判据换成「写了坏值」与「整个省略」两个结果对比，而不是比对我猜的字面量。
>
> **残留窗口如实记（未修，不主张已关）**：C1 的 `wx` 只挡住「覆盖已完成的密钥」；竞态者若**仍在写中途**，
> 回读可能拿到短密钥。关掉它要的是锁而不是 flag，不属这道守卫的范围。

- **C1 + C3 + C4 是同一处的一笔**（都落在 `getOrCreateKey` 这 10 行里）：
  `writeFileSync(keyPath, key, { mode: 0o400, flag: 'wx' })` + **`EEXIST` 时回读**（这才是 `wx` 的正确收尾），
  再把 `:62` 的 `mkdirSync` 补 `mode: 0o700`。
  **仓库里已有正确写法**：`src/mcp/token-store.ts:39` 就是 `writeFileSync(f, data, { mode: 0o600 })` —— 同一「定义在那儿、施加点没接上」。
- **C2**：给 `:607`/`:611` 补 typeof 守卫（**照 `:640` 的兄弟写法**），
  `mergeProviders` 的 `op` 补 null 守卫。**不改行为，只补守卫** —— 非字符串值当作「没有键」处理。
- **验收**：C1 用两进程屏障让 `wx` 对照翻转（子代理已证 3/3）；C3 量 inode/模式序列；
  C2 用非字符串矩阵（number/array/object/bool + `providers:[null]` + `providers:"x"`）。

### 批次 3 — E 族余项：E1 + E2 + E3 + E5 + E6 + E7 + E8

- **E1**：给 daemon 路径**接上**真正的掩码配置（而不是删掉掩码）—— 把 `createToolRegistry()` 的
  无参调用改成显式传入由配置派生的 ctx。**接线的同时保持 daemon 的 fail-closed 语义不变**。
- **E2**：项目级 `credential_masking` **不能放宽**（只能收紧或持平）—— 与 `mergeProviders` 里
  `baseUrl` 已有的「只有受信（用户级）config 才能覆盖」是同一个判据，**照那条写**。
- **E3**：`detached` + 杀**进程组**（`process.kill(-pid)`），并把读 stdout 挪到 `await proc.exited` **之后**。
  子代理已证 `detached`+组杀**确实能收掉孙进程**（对照能红）。
- **E5–E8**：各自独立小修；E7 与刚落的 2.58.0 #25（错误归因）同族，照那条的风格写。

### 批次 3 落地状态（2026-09-19 收工）

七笔：`f0cc571`(E1) / `ecb16df`(E2) / `0956d4b`(E3) / `237870e`(E5) / `ecf1e35`(E6) / `f021fe9`(E7) / `26153a2`(E8)。
七条全落，零延期。测试 2725 → 2767（235 → 241 文件）；typecheck / prettier / lint 全绿；`/crsi eval` 不退化。

**与本节原计划的偏差（如实记）：**

1. **E1 的修法落在注册表而不是 daemon 调用点**。原计划写「把 `createToolRegistry()` 的无参调用改成显式传入
   由配置派生的 ctx」。落地时发现真正的问题在**默认值的方向**：`defaultVajraContext()` 注入的是一个
   `DISABLED_CREDENTIAL_MASKING_CONFIG`，注释自称「对齐 pre-seam 行为」—— 掩码是安全控制，「没配置就关掉」
   是错的默认值。**在注册表里改方向，daemon 侧一个字都不用动**，比在调用点补 ctx 更小也更难复发
   （补调用点只堵住今天已知的那一处）。只取**用户级**配置：注册表是进程级单例、各会话 cwd 不同，
   套项目级会让规则溢到别的会话。
2. **E8 的第一项（「worktree 逃逸守卫是字符串比对、别名 cwd 可绕过、探针已红」）是陈旧读数**。
   该守卫已于 `23b6154`（2026-09-18，本 HEAD 的祖先）改成 `resolve` + `isWithin`，那次提交**删掉的行**
   逐字就是本行描述的字符串比对。计划自己标的证据等级也写着「读码 + 探针（**未找到路径**）」。
   ⇒ **不复述为「本轮已修」**。E8 实际修的是它的另外两项（`ExitWorktree` 的 `process.cwd()` 基数、
   第 67 行的 `includes` 子串判定），并顺带收口 E5 提交里记过的同族第 98 行。
   核实方法：`git merge-base --is-ancestor 23b6154 HEAD` + `git log -S isWithin`。
3. **E7 计划里写的 `Exit code 143` 是错的，实测 137**（发的是 SIGKILL 不是 SIGTERM）。**以实测为准**。
4. **§五 第 4 步「`/crsi eval` 应打印 `score=100 passed=38/38`」描述不实**：harness 是**断言**不是打印 ——
   `cd apps/cli && npx vitest run test/core/eval-harness.test.ts` 跑出 13 个用例全绿，屏幕上一个分数都不印。
   判据应写成「13 条契约用例全绿（内含 38/38 与 score=100 的断言）」。

**本条并入 E8 后复量的两点未修观察**（属另一件事，不排期）：`cd <symlink>` 落点在工作树外时逃逸守卫不响
（`isWithin` 不做 realpath），`pushd /etc` 也不响（正则只认 `cd`）。不修的理由：收紧的只是 `cd` 这一种拼写，
同一个 Bash 工具不 `cd` 也能读 `/etc/passwd`，收紧了并不关掉任何真实访问面 —— 那是仪式不是检查。

### 批次 4 — P 族：P1 + P2 + P3 + P4 + P5 + P6

- **P1**：`permissionRestrictions` 的**格式校验 + 警告**，照 `getInvalidRules()` 的既有形状
  （同一份失败，两条通道待遇应当一致）。**fail-closed 方向**：不认识的模式名 → 拒绝而不是忽略。
- **P2**：模式上限必须**同时**约束 allow 规则通道 —— 把上限判据提到 `check()` 第 3 步**之前**，
  或让 `allow()` 感知 `this.restrictions`（后者更小）。**两者副作用不同，实现时先写用例定住语义。**
- **P4**：层级顺序与「越靠后越宽」的实际语义对齐（`plan` 不该排在 `acceptEdits` 之上）；
  `getAllowedModes`/`isModeAllowed` **要么接线要么删**（零消费者 —— 与 T4 的处置形状一样，
  删的必须不存在、留的必须仍零引用）。
- **P3/P5**：状态与执行**同源**（页脚读钳制后的值）。

---

### 批次 4 落地状态（2026-09-19 收工）

五笔 / 六条：`8c4dc128`(P4) / `5af57957`(P1) / `8459185d`(P2) / `e728884e`(P3+P5) / `9170fae2`(P6)
—— P3 与 P5 同源、合并为一笔。六条全落，零延期。测试 2767 → 2800（241 → 244 文件）；
typecheck / eslint / prettier 全绿；`/crsi eval` 38 条冻结契约不退化。

**与本节原计划的偏差（如实记）：**

1. **P2 走的是第三条路，原计划给的两条都没选**。原计划写「把上限判据提到 `check()` 第 3 步之前，
   或让 `allow()` 感知 `this.restrictions`（后者更小）」。落地时选了**在 allow 命中之后单独判一次**
   （`allowRuleDecision`）：让 `allow()` 感知 restrictions 会把**注册当时**的状态冻进规则，而
   `setRestrictions` 在 `index.tsx` 里是**条件调用**（`if (config.permissionRestrictions)`）、
   且 `loadConfig` 是第二条落点 ⇒「先 setRestrictions 再 allow」这个顺序前提是真会破的。
   把判据放在 check 时，前提就不存在了。**如实记**：今天两处生产入口恰好都先 setRestrictions，
   故两种设计的**当前**行为等价 —— 选后者是为了去掉那个隐式前提，不是修一个正在发生的 bug。
2. **判据的边界是有意停住的**：`allowRuleDecision` 取「上限那一档自己的基线」，遇到
   `'mode-baseline'`（`default` 档）时**停在 `tool.permission`**，不再往 `check()` 第 7 步的
   legacy 兜底走 —— 那个兜底只可能比 `'ask'` 更宽，够到它就等于把上限交给一个更宽的来源。
3. **P3/P5 的修法不在页脚，在装配点**。原计划只写「状态与执行同源」。落地把权限系统**建一次**
   （`index.tsx` 的配置加载处）、交给 `new QueryEngine(...)`，页脚与系统提示都回读这一个实例。
   理由：在页脚侧「照 config 再算一遍」正是本仓库反复出现的形状（同一个量算两处、只接一处）。
   `RemoteEngine` 的桩补 `getMode`，报**用户最后请求的那一档** —— 与页脚原有行为逐字相同。
4. **`getAllowedModes` / `isModeAllowed` 按计划的「要么接线要么删」处置完毕**：`isModeAllowed`
   全仓库零引用（含文件内）⇒ 删；`getAllowedModes` 唯一消费者在同文件内 ⇒ 撤 export。
   与 T4 同形（删的必须不存在、留的必须仍零引用）。
5. **P4 存在一处有意偏离**：`forbiddenModes: ['bypassPermissions']` 的兜底从 `plan` 变
   `acceptEdits`，即降级结果**更宽** —— 旧值偏窄本身就是「越过目标」的产物，不是另设的安全边界。
   行为变更点名：`maxAllowedMode: 'plan'` 现在只保留 plan（此前保留三档）；
   `maxAllowedMode: 'default'` 现在保留 plan + default。两处都是**收紧**。
6. **P6 未找到活的产出路径**（如实记）：四处 `SubAgent` 构造点（`tools/agent/agent.ts`、
   `workflow/primitives/agent.ts`、`skills/fork-executor.ts`、`ui/commands.ts`）加 `engine.ts:1219`
   的工具上下文**全都传了**权限系统。本项关闭的是 fail-open 的**默认姿态**，不是已观测到的利用。
   缺省档取 `default` 是**量出来的**而非猜的：负控把缺省档换成 `bypassPermissions` 只 1 红、
   换成 `plan` 会红 6 条（其中 4 条既有用例证明这条路径在测试里一直是活的）。

**两条未修观察（属另一件事，不排期）：**

1. **Shift+Tab 之后系统提示那段 `## Permission Context` 不重建**，仍描述切换前的模式。不修的理由：
   重建要动整份系统提示，代价是每次切档都让 provider 的 prompt cache 失效；且被拦下时
   `explainDenial` 会说清是哪条规则/哪一档拦的。本项只保证**建它那一刻**用的是真对象。
2. **喂给嵌套工具的 `permissionSystem: subPermission` 刻意不动** —— 子代理自己的闸修好了，但嵌套
   工具上下文里那个字段在「调用方没传权限系统」时仍是 `undefined`。属另一个决定（嵌套工具的语义
   与子代理自身的闸不是同一件事），此处只记录。

### N1 落地状态（2026-09-19，一笔 `cd7a65c7`）

> **用户裁定的两问两答（均取推荐项）**：① 信任闸的处置 = **加载点 fail-closed**（不是「在两个入口各加一次询问」）；
> ② hook 子进程的 env = **一并收口**。

落地内容与判据：

1. **闸从「进程级一次、只在 TTY」下移到加载点**：`loadSettingsJson(cwd, { includeProjectHooks })` 默认 **false**
   —— 读项目级 hooks 被重新定义成「一次信任行为」而不是默认。三处调用点各自表态：`index.tsx` 与 daemon 的
   `hooksFor` 取 `getWorkspaceTrust().isTrusted(cwd)`；`/hooks` 显式传 `true`。
   为什么 `/hooks` 是例外：它**只显示**，用默认值会把真实存在的 hooks 藏起来；而它同时是 TUI 命令，
   TUI 只在 `checkWorkspaceTrust()` 落定之后才启动 ⇒ 列出来不算误导。
2. **`permissions` 不受该开关影响**（仍双层级合并）：那个问题由**模式上限**回答，不由信任回答。
   过闸过度会静默改掉既有行为，故单列一条用例钉住（`still merges project permissions with the default gate closed`）。
3. **跳过必须说出口，且不许说没发生过的**：`SettingsJson` 新增 `projectHooksSkipped`（只在 `true` 时出现），
   由**同一份解析**回答「到底有没有东西被扣下」，故 `warnProjectHooksSkipped()` 不可能跑在事实前面。
4. **hook 子进程 env 走同一条 `filterEnv`**（与 Bash 同策略），只取**用户级**配置 —— `HookContext`
   不带 cwd，没有会话作用域可读项目段（与 §一 E1 的注册表裁定同源）。

**一处自我纠错（如实记）**：第一版直接在两个调用点写警告，全绿那一跑打出 **8 条**「skipped hooks from …」
——**包括根本没有 `settings.json` 的工作区**，即断言了一个不存在的对象（正是本条要修的缺陷族）。
改成由 loader 报告后，警告收敛到**恰好 1 条**，并补 D4c 钉住反方向（没有项目 hooks 就不许告警）。

**三条负控互不相同**（每条先断言匹配数再落补丁，落盘文件以 SHA-256 逐字校验还原）：
N-A `readHooks` 恒 `true` ⇒ **3 红**；N-B 无条件报告跳过 ⇒ **1 红**（正是反方向的 D4c）；
N-C 摘掉 `env` 传参 ⇒ **1 红**。

**两条未修观察（如实记，不在本项范围）**：

1. `hooksFor` 生成 hook stdin 与 `spawnSync` 的隐式 cwd 用的都是 `process.cwd()`，而这里本该是**会话 cwd**
   —— 与 E8 同族（`process.cwd()` 之于 `ctx.cwd`），且是既有偏差。**已于 2.64.0 落地**（见下节）。
2. `/hooks` 在未信任状态下仍列项目 hooks，且**不标注**其已被闸住。**已于 2.65.0 落地**（见下节）。

**本笔同时是排版事故的现场（同族第二次栽，如实记）**：修订历史新行第一次写成「单元格内嵌竖线」⇒
markdown 表把它读成列分隔符，prettier 把整表重排、`CLAUDE.md` 39,223 → **40,826，越过 40k 上限**。
改法是不在单元格里放竖线（写成「或……二者其一」），并把判据定成**竖线根数 + `diff --stat` 零 deletion**。
落定 39,796 字符（余 204）。

### 观察② 落地状态（2026-09-19，一笔 `b3c0dd41`，`CLAUDE.md` 2.64.0）

缺陷形状与 E8 同族：**判据拿的是近似的替身**。`executeCommand` 用 `process.cwd()` 同时回答了两个问题，
而两个都不属于本进程：

- hook **在哪个目录跑** —— `spawnSync` 没给 `cwd`，于是继承本进程的；
- hook **被告知**自己在哪 —— stdin 的 `cwd` 字段（`buildHookStdin`）也填它。

一次性 CLI 上两边恰好都对（会话 cwd 就是 `process.cwd()`）。daemon 一个进程服务多个会话，
`process.cwd()` 是它自己被启动时所在的目录、**不属于任何会话** ⇒ 每个 daemon hook 都落在那里跑、并读到那里。

**改法是接线，不是改 `hooksFor` 的参数。** 会话 cwd 一路都是拿得到的
（`server.ts` `getOrCreateEngine(sessionId, session.cwd, …)` → `wireDaemonEngine(engine, { cwd })` →
`hooksFor(opts.cwd, skills)`），只有 `executeCommand` 把它重新推导成了进程 cwd。
`HookContext` 增可选 `cwd`，由 `HookEngine` 在 `runHooks` **一处**盖章 —— ctx 由 13 个 `executeX`
各自构造，逐处写必然漏掉几个；而 cwd 是**引擎**的属性，不是某次调用或某个 hook 的属性。
两个构造点各自表态：daemon 传会话 cwd，CLI 显式传 `process.cwd()`（写出来是为了与 daemon 那处成对照）。

**两份副本同改**：`apps/cli/src/shared/types.ts` 是 `packages/shared/` 的 vendored 副本，而 `src/**`
import 前者、测试 import 后者 —— 只改一份 typecheck 立刻红（本次实际发生）。`packages/shared` 是发布出去的那份。

**判据是「两半都断言」**：跑在哪 + 被告知在哪。只修一半等于让 hook 被告知一个它不在的地方 ——
这正是本条缺陷的形状，所以只断「`cwd` 存在」不够；`hooks-executor.test.ts` 另反向断言它**不是** `process.cwd()`。

**三条负控红集互不相同**（每条从同一份干净快照起、先断言匹配数再落补丁，还原后逐文件 SHA-256 比对）：
撤掉 `spawnSync` 的 `cwd` ⇒ **2 红**；撤掉 `runHooks` 的盖章 ⇒ **3 红**；daemon 退回默认构造 ⇒ **1 红**
（正是 D4d ⇒ 该用例真的钉在 daemon 的传参上，不是被引擎默认值顺带满足的）。

**过程中一次事故（如实记）**：负控脚本第一版在**每次**运行开头做备份 ⇒ B 备份的是 A 打过补丁的盘、
C 又备份了两者，红集 2 → 5 → 5，B 与 C 不可区分（「三条互不相同」当时是假的）；还原循环也写错，
三个备份全写进同一个文件，把 A、B 的补丁**留在了盘上**。重写为「一次快照 + 每条只落一个补丁 + 还原后
SHA-256 比对」后才拿到互不相同的红集。

**一条没写的用例（如实记）**：「不覆盖调用方已设的 `ctx.cwd`」在公开 API 上不可达
（`executePreToolUse` 不接受 cwd），断言无法失败 —— 与其写一条永远绿的用例，不如不加；
盖章因此是普通赋值而非 `??=`，也没有为此引入无人调用的分支。

**未修观察（如实记，不属本笔范围）**：hook 的凭据掩码仍取**用户级**配置，而交互式 CLI 的 Bash 拿的是
**项目级**（`index.tsx` 自己的 ctx）。`HookContext` 现在带 cwd 了，按会话收敛在技术上成为可能 ——
那是**掩码策略**的改动（多会话进程里项目段该不该施加于 spawn），不是接线，另案。

**剩下一件**：无 —— 三条观察（①②③）至此全部落地。**§四「需裁定」亦已清空**：第 1 行（rotate
通知措辞）于 2.68.0（`9a170302`）落地，第 2 行（N1）早已落地，第 3/4 行是「不排 / 不修」的已决项。

### 观察③ 落地状态（2026-09-19，一笔 `2c61a0cb`，`CLAUDE.md` 2.65.0）

缺陷形状是**显示面的诚实边界比执行面窄**。`/hooks` 是**唯一**故意传 `includeProjectHooks: true` 的调用点
（N1 的裁定：它只显示，用 loader 默认值会把真实存在的 hooks 藏起来），于是也是**唯一**会在一道关着的闸后面
渲染项目 hooks 的地方 —— `index.tsx` 与 daemon 的 `hooksFor` 都按 `isTrusted()` 决定读不读，闸关时根本不加载。

**根因不是「忘了标」，是信息在到达显示层之前就没了**：`loadSettingsJson` 把项目级与用户级的条目 concat 进
同一个 bucket，而两者受**不同管辖**（只有项目级那条过信任闸）⇒ 拿到合并列表的调用方**在结构上不可能**说出
哪条会被执行。所以修法**落在加载处**，不在显示处重解析 —— 后者正是本仓库反复栽的「两条渲染路径只接一条」。

**两条轴，不许互相顶替**：标注跟**来源**走、闸只管**标不标**。

| 落地点                                 | 改动                                                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/loader.ts`                     | `SettingsJson` 增 `projectHooks`，与 `projectHooksSkipped` 共用同一条「**只在真发生时才出现**」的规则：调用方表了态**且**项目文件真声明了**非空** hooks 才附上（空 bucket 不算）；`searchPaths` 每项加 `project` 判别位而非靠下标 |
| `ui/commands.ts`                       | 分**两次**取（不带选项 = 用户级，带选项 = 项目级），逐行标 `[project]`/`[user]`，闸关时只给项目级行追加「不会运行」                                                                                                               |
| `i18n-core/locales/{zh-CN,en-US}.json` | 三个新键：`source_user` / `source_project` / `gated`                                                                                                                                                                              |

**受信时输出与从前逐字相同**（同一事件内仍是项目级在前，与合并列表顺序一致）⇒ 对已受信工作区不可见。

**四条负控红集互不相同**（均从同一份干净快照起、每条只落一个补丁、还原后逐文件 SHA-256 比对）：
`gated` 恒 `false` ⇒ **1 红**；`gated` 恒 `true` ⇒ **1 红**（另一条）；标注不看来源 ⇒ **2 红**；
`projectHooks` 无条件附上 ⇒ **4 红** —— 多出的那条正是「无 `settings.json` 时整对象相等」，即
「只在真发生时才出现」这条规则还兼着**别把空对象塞进全等断言**。

**另跑一次真件端到端**（`process.chdir` 到临时工作区 + `os.homedir` mock 到临时 HOME + 真 loader）：
受信/未受信两份输出逐行核过，计数不变、顺序不变 —— 用例里 loader 是 mock，这一步是防它与真件漂移。

**未修观察（如实记，不属本笔范围）**：`Location: .mipham/settings.json` 早就在误述这份合并列表（它同时含
`~/.mipham/settings.json` 的用户级条目）。本笔新增的 `[user]` 标签让这处更刺眼，但**不顺手改** ——
它会动到受信工作区的输出，正是本笔刻意保持不变的那一面。

#### 顺带发现：档案 `history.md` 的 84% 是 padding（已量、未改）

落地时按滚动窗口硬约定把挤出的 2.62.0 窗口行移到 `docs/claude-md-history.md`，途中量到：
**694,445 字符里 584,333（84.1%）是 prettier 补的空格**，真实内容只 109,617 字符（296 个表格行）。
机制与 `CLAUDE.md` 撞 40k 完全相同 —— 列宽 = **最宽那一行**，全表按它补齐。

**一次实险（如实记）**：往表内追加文本时误删了该行收尾的 `|`，那一行随即不再被 prettier 当作表格行
⇒ 最宽行易主 ⇒ 全表缩回 ~240 列，**文件当场从 694,445 掉到 142,452**（不是内容丢了，是 padding 没了）。
已 `git restore` 复原并逐字复核（694,445 = HEAD）。

**因此本笔的挤出存档放进围栏块、不并进表内**：+1.4 KB；若并进表格则要让 296 行各补一次 ≈ +163 KB。
同时归档了一条与本表 2.62.0 行**内容不同**的文本（表里那份是批次级概述，窗口行是该版本自己的收口，
含批次概述没有的负控读数与「未找到活的产出路径」）—— 即 CLAUDE.md 那句「被挤掉的行都已在 history.md，
**逐字不丢**」在 2.62.0 上**实测不成立**；2.63.0 / 2.64.0 同样有约半数子句不在档。
本条只报不改（属档案结构决策）。

## 三、已被本轮验证「仍然成立」的旧修复（不重报，仅备查）

每条都配有**能失败的对照**：

- **2026-09-14 loopback 修复仍成立**：伪造 `Host: localhost`/`127.0.0.1` 的远程 peer → 401
  （对照：真 loopback 无凭据 → 200）；含 `text/plain` 简单请求在内的浏览器可驱动 Origin 形状 → 403；
  无 Origin → 200，且**无状态变更**。
- WS 升级在**两道闸之后**（对照三元组：无凭据 401 / 有效 token 101 / 恶意 Origin 403）。
- CORS 是**精确** allowlist，从不 `*`，无 `Allow-Credentials`（后缀/大小写/尾斜杠 Origin → 403）。
- 限流器**只**按 socket peer 计数（轮换 `X-Forwarded-For`/`X-Real-IP`/`Forwarded` 仍 429）。
- 16 种畸形/重复 `Authorization` 形状**无一**被授权；64 KB 头 → 431。
- 会话 `cwd` 收敛有效（`/etc`、`..`、`/tmp` → 403，而 `.` → 201 ⇒ 不是一刀切拒绝）。
- token 熵 256 位、创建 0600 / 目录 0700、从不入日志。
- **凭据落盘面**：IV 每次加密都用新随机值（对照：固定 IV ⇒ 密文逐字节相同）；
  GCM tag 真正被校验（对照：零 tag ⇒ **合法**密文也失败）；篡改被检出；
  8 种畸形 `enc:v1:` **无一**被当成明文放行；加密不可用时**无明文回退**（3 种失败模式）；
  MCP 子进程**不**继承 API key（内建对照：`PATH`/`HARMLESS_VAR` 必须是 PRESENT）。
- **执行面**：Bash 的 argv 元素表固定、无模型 token 进 `argv[0..1]`；
  checker 看到的是 shell 所见的**超集**（raw ⊎ ANSI-C ⊎ 净化）—— 对照：同一模式在 raw 上就会响，
  所以零宽/全角的用例不是空转；`task.ts` 不 spawn 任何东西。

---

## 四、需裁定 / 未决

| #   | 事项                                                                                                      | 我的建议                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **CLI 侧 `mipham rotate` 不通知在跑的 daemon**（`bin/mipham.ts:1035`）：旧 token 到 daemon 重启前一直有效 | ✅ **已落地（2.68.0，`9a170302`，用户选「明说旧令牌仍可用 + 给动作」）**：输出改为「⚠️ 仍 ACCEPTS 旧令牌」+「`mipham daemon restart`」，并配行为测试。**不做**跨进程通知（简洁优先，且那需要新端点）。 |
| 2   | **N1（工作区信任闸非 TTY 自弃、且 `mipham run`/daemon 不调用它）**                                        | ✅ **已落地（`cd7a65c7`，用户裁定：加载点 fail-closed + env 一并收口）**，见「N1 落地状态」节。                                                                                                        |
| 3   | D5 / D6 / E6 / 各 INFO 项                                                                                 | 本计划**不排**（LOW / INFO）。若要收，建议并进批次 3/4 顺带做。                                                                                                                                        |
| 4   | C5（密钥与密文同目录）                                                                                    | **不修**（上限非缺口，见 §一 C5 说明）。                                                                                                                                                               |

---

## 五、每批的验收流程（硬性）

每一批收工前**必须**跑完，缺一不可：

1. `cd apps/cli` 再 `pnpm test`（**必须 `cd` 进去** —— 从仓库根跑会因 MCP 子进程继承
   `process.cwd()` 产生 31 个**假红**）
2. `pnpm typecheck`
3. lint / prettier（父仓库**不跑** prettier，只跑 `mipham-code` 子仓）
4. `/crsi eval` **不退化**（跑法：`cd apps/cli && npx vitest run test/core/eval-harness.test.ts`，
   应打印 `score=100 passed=38/38`；**没有 `--crsi-eval` 开关**）
5. **文档数字同提交回填**（测试数 / 文件数 / 版本 / 修订历史 3 行滚动窗口 / `CLAUDE.md` ≤ 40,000 字符）
6. 提交信息遵循 Conventional Commits，**不写「对标 CC」**

---

## 六、修订历史

| 版本 | 日期       | 变更                                                                                       |
| ---- | ---------- | ------------------------------------------------------------------------------------------ |
| —    | 2026-09-19 | 初版：审计四面 + N1 前提；批次 1 = D1/D2/D3/E4（用户裁定）                                 |
| —    | 2026-09-19 | N1 落地（`cd7a65c7`）：信任闸下移到加载点（fail-closed）+ hook 子进程 env 并入 `filterEnv` |
