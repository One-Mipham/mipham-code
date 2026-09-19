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
> **已呈报，用户本批未裁定** ⇒ 本计划**不纳入**，列为未决事项，等明确指令。

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
  **已落地部分**：CLI 侧补一行提示「运行中的 daemon 保留旧令牌直到重启」（见本节状态块第 3 条）；
  **主动通知在跑的 daemon 仍未做**，那条裁定仍开着。

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

| #   | 事项                                                                                                      | 我的建议                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **CLI 侧 `mipham rotate` 不通知在跑的 daemon**（`bin/mipham.ts:1035`）：旧 token 到 daemon 重启前一直有效 | 在输出里**明说**「需重启 daemon 生效」并补一句文档（**不做**跨进程通知 —— 简洁优先，且那需要新端点）。**属行为变更，不自行决定。** |
| 2   | **N1（工作区信任闸非 TTY 自弃、且 `mipham run`/daemon 不调用它）**                                        | 本批**不纳入**。它是一个**设计判定**（项目级 hooks 是否该信任），不是纯缺陷。已呈报，等明确指令。                                  |
| 3   | D5 / D6 / E6 / 各 INFO 项                                                                                 | 本计划**不排**（LOW / INFO）。若要收，建议并进批次 3/4 顺带做。                                                                    |
| 4   | C5（密钥与密文同目录）                                                                                    | **不修**（上限非缺口，见 §一 C5 说明）。                                                                                           |

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

| 版本 | 日期       | 变更                                                       |
| ---- | ---------- | ---------------------------------------------------------- |
| —    | 2026-09-19 | 初版：审计四面 + N1 前提；批次 1 = D1/D2/D3/E4（用户裁定） |
