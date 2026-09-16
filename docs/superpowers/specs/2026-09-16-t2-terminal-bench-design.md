# T2 — 公开一份可复现的基准成绩（Terminal-Bench 4.0 / Harbor）

> **日期**: 2026-09-16
> **对应 ROADMAP**: T2「公开一份可复现的基准成绩」
> **性质**: 实现规格（架构级 —— 含产品缺陷修复 + 新子系统 `benchmarks/`）
> **前置**: T12 已结项 ⇒ 仪器前置三件齐备（Docker 干净环境 / daemon 权限策略 / 工具成败位可读）
> **方法**: 全部结论以读码 + 机器证据得出，不凭文档描述下结论。本文中每条「实测」均指本轮真跑过的命令
> **范围外**: route B 无头一次性 CLI、ACP 协议、全量 54 题

---

## 〇、摘要

T2 要交的是一份**可复现、且经得起辩护**的 Terminal-Bench 4.0 成绩。本轮 spike 已把仪器验通（54 题数据集、预置镜像、oracle 基线 1.000），但**接入路径上挖出一个已发布的产品缺陷**：

**`mipham daemon start` 在任何编译产物里都起不来**，且**谎报成功**。两个独立缺陷叠加（缺 `bun` / `$bunfs` 虚拟路径），外加一处「失败印成成功」。因此 T2 拆成两件：先**修 daemon 自启**（独立提交），再由 **Harbor 适配器直驱 daemon REST API** 跑出成绩。

同样在本轮落地的是**模型闸门**，结论是否定的：四个微调模型只在本地、未上云，
且即便走本地 Ollama，**三模型 × 两端点无一产生 `tool_calls`**（§1.4）⇒ 按 §六 的失败分支
回落 **`deepseek-v4-pro`**。

三个岔路口本轮全部关闭：**接入路线 A+**、**发布模型 = `deepseek-v4-pro`**、**先 10 题 × k=1 打通管线**。

---

## 一、背景与既定决策

### 1.1 岔路口处置

| 岔路口   | 决议                                                         | 依据                                                                                                             |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 接入路线 | **A+** —— 修 daemon 自启 + adapter 直驱 daemon REST API      | 方案 1 在既定路线上直达，10 题 spike 代价最小；方案 3（无头 CLI）是它的自然下一步而非替代                        |
| 发布模型 | **回落 `deepseek-v4-pro`** —— 自家四模型已实测不成立（§1.4） | Terminal-Bench 量的是 **agent × 模型** 组合，不点名模型则成绩无法解释。闸门已验且**失败**，走 §六 原定的失败分支 |
| 开工规模 | **10 题 × k=1**，管线打通后再决定是否全量                    | 符合本仓库「先 spike 再全量」惯例；避免管线隐病一次烧掉全量                                                      |

### 1.2 daemon 自启缺陷（本轮实测）

| 运行方式                                  | `daemon start` | 证据                                                                     |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| 源码 `bun run bin/mipham.ts`              | ✅ 真起来      | PID 17986 / port 45671，`lsof` 见真 LISTEN；`stop` 后无残留              |
| 编译产物 `dist/mipham`（本机**有** bun）  | ❌ 谎报成功    | 打印「Daemon started」，但 `daemon status` = not running、无监听、无进程 |
| GitHub release 二进制（容器，**无** bun） | ❌ ENOENT 崩溃 | `at spawn (node:child_process:721:35)`                                   |

**根因（`bin/mipham.ts:338-339` 与 `:400-401`）**：

```ts
const daemonScript = new URL('./daemon.ts', import.meta.url).pathname
const child = spawn('bun', ['run', daemonScript], { detached: true, stdio: 'ignore' })
```

1. **`bun` 是裸名字**，走 PATH 解析。而编译产物的全部意义就是用户不必装 Bun ⇒ 容器内 ENOENT。
2. **`$bunfs` 虚拟路径**：shim 实测截获原文 `ARGV: run /$bunfs/root/daemon.ts`（`exists=no`）。`bin/daemon.ts` **无人 import**（仅被上述字符串拼出），不在 `--compile` 模块图内 ⇒ 根本没打进产物。新起的 bun 进程读不到父进程的 bunfs ⇒ **本机有 bun 也照样失败**。
3. **谎报**：`getDaemonStatus()` 返回 null 时走 `console.log('Daemon started (PID unknown — check ...)')`，把失败印成成功。

**为何至今未被发现**：日常开发走源码（`import.meta.url` 是真路径 + bun 在 PATH），实测正常。又一例「dev 能跑 ⟹ 产物里静默坏掉」。

### 1.3 为何这个缺陷归 T2

其一是 T2 的阻断项 —— 交付物是编译二进制，adapter 在容器里只有它。其二是**它本就是产品缺陷**：daemon 是招牌能力（T5 刚做过 daemon ↔ CLI 能力对等），且 fix 后**编译产物才能真正提供 daemon**。故作为独立提交先行落地，T2 的 spec 声明依赖它，不把它裹进基准工作。

### 1.4 模型闸门：已验，且**失败**（本轮实测）

原假设是「先探云端 `om-v5-pro`」。**该假设不成立**：四个微调模型只存在于本地 Ollama、
并未上云 ⇒ 云端 `api.onemipham.com` 不服务它们，也就**不存在一把对应的密钥**。
「生成 API key」这个问题因此**消失**，而不是被绕过 —— 没有对象可签。

改探本地权重。`/api/show` 申报 `capabilities: ['tools', ...]`，**但申报不等于事实**：

| 模型                      | `/v1/chat/completions` | `/api/chat`（原生） |
| ------------------------- | :--------------------: | :-----------------: |
| `v5-pro:latest`（7.6B）   |           ❌           |         ❌          |
| `v5-apex:latest`（14.8B） |           ❌           |         ❌          |
| `v5-flash:latest`（1.5B） |           ❌           |         ❌          |

**三模型 × 两条独立端点路径，无一返回 `tool_calls`。** 三条从**原始报文**读出的事实：

1. **`tool_choice` 被静默忽略** —— 传强制 `{"type":"function","function":{"name":"get_weather"}}`
   仍回 `finish_reason: "stop"` + 纯 `content`。故**「模型自己不调」与「服务栈不认 tools」
   用强制模式分不开**，该判据无效。
   （过程中一次 0.8s 的快速返回曾被读成「响应快」，实为 prompt 前缀缓存命中 ——
   **不以原始报文为准就会误判**，这条本身是方法教训。）
2. **模型直接编造**：问北京天气，回「北京现在天气晴朗，气温在15度到20度之间」。
   接进 agent 循环的表现即「编一个工具结果」——比报错更坏，因为看起来像成功。
3. **不只是模板缺口**：`v5-flash` 的模板**含** tools 段，照样不发 `tool_calls`。

⇒ **这是能力天花板，不是集成问题。** 7B / 14B / 1.5B 的 Q4 蒸馏权重做本地 chat 可以，
做 31 工具 agent 循环不成立。**按 §六 的失败分支回落第三方。**

### 1.5 容器 → 宿主机 Ollama 的可达性（反直觉，实测）

Ollama **只绑 `127.0.0.1:11434`**（`OLLAMA_HOST` 未设），但这**不**意味着容器够不到：
Docker Desktop 把宿主机 loopback 代理给了 `host.docker.internal` ⇒ 容器内
`http://host.docker.internal:11434` **开箱即用**，`GET /api/tags` 回 200 并列出全部模型。
（`172.17.0.1` 不通；`192.168.65.254` 通，同一个代理。）

**一个坑**：`Host` 头须写成 `主机:端口` 形式。发畸形的 `Host: x` 会被 Ollama 的
DNS-rebinding 防护**判 403** —— TCP 明明是通的，别误判成「网络不通」。
（本轮第一次探测就踩了这个，差点把结论写反。）

**记录此节的理由**：它证明「用自家权重跑基准」在**网络层是可行的**，唯一障碍是 §1.4 的
能力天花板。不记则将来有人会重走一遍这条路。

---

## 二、daemon 自启修复

### 2.1 机制：re-exec 自己

产物中 `process.execPath` **就是二进制本身**。新增隐藏入口（`__daemon`），改为 `spawn(process.execPath, ['__daemon', ...])`；`bin/daemon.ts` 的 40 行逻辑（解析 `--port`/`--bind` → `startDaemon()` → `SIGTERM`/`SIGINT` 处理）平移至该分支。

**源码路径必须保持可用** —— `bun run bin/mipham.ts daemon start` 现在正常，不可弄坏。`bin/daemon.ts` 保留。

被否的两个备选：同进程内 fork（改进程模型，且 daemon 与 TUI 抢生命周期）；单独编译第二个产物（构建链复杂度上升）。

### 2.2 两条硬约束

- **cwd 必须继承**。§三 的 cwd 白名单完全建立在「`daemonRoot` = 任务目录」上；re-exec 若换掉 cwd，adapter 会以 403 崩掉。这是本修复与 §三 的**接口契约**。
- **不得再谎报成功**。起不来必须报错退出（非零退出码 + stderr），`daemon start` 的返回必须可被脚本判真伪。

### 2.3 测试策略（含一处诚实边界）

**这个 bug 只在编译产物里存在** —— `import.meta.url` 在 `--compile` 下是 `$bunfs` 虚拟路径。单元测试跑在源码下，**而老代码在源码下是好的**，故单测**抓不到它**。分两层：

| 层       | 断言                                                                                                                            | 能抓到什么                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 单测     | `daemon start` 传给子进程的 `argv[0]` 是 `process.execPath`，且**不是**裸 `'bun'`；`bin/daemon.ts` 的逻辑在 `__daemon` 分支可达 | **形状**。防回归：有人改回裸 `'bun'` 立即红 |
| 产物冒烟 | `bun build --compile` 后真跑 `dist/mipham daemon start`，断言 `daemon status` 说 running                                        | **行为**。**这一步正是当初缺的那一步**      |

**诚实边界**：行为层**只能由产物冒烟覆盖，单测无论如何设计都覆盖不到**。冒烟测试进 CI 的 `build-cli` 之后，与 post-CRSI「发布产物冒烟测试」同一范式。

---

## 三、适配器架构

### 3.1 形态

`benchmarks/harbor/mipham_code.py` —— 继承 Harbor 的 `BaseInstalledAgent`，照 `muse_code.py`（Harbor 0.23.0 内置，193 行）的形状。Harbor 要求的接口：`name()` / `version()` / `install(env)` / `run(instruction, env, context)`，配 `exec_as_agent(...)` 在容器内执行、产物写 `EnvironmentPaths.agent_dir`。

**与 muse 的关键差异**：Muse 有 `muse exec`（无头一次性），**Mipham 没有** —— 故 adapter 不能照抄那个形状，必须自己驱动 daemon。这正是 A+ 与 route B 的分野。

### 3.2 `install()`

**直接下载预编译二进制**，不走 `install.sh`。

理由（实测）：`install.sh` 在裸 Debian 容器里检测到「No runtime detected」→ 尝试装 Bun → `error: unzip is required to install bun` → **mipham 一个都没装上**。prebuilt 二进制实测可用（83.6 MB，`--version` → `@miphamai/cli v0.81.6`，`--help` 正常）。

### 3.3 `run()` 主线

```
① 在任务工作目录内起 daemon（cwd 即白名单边界）
② 轮询 GET /api/v1/health 至就绪
③ POST /api/v1/sessions   （cwd = 任务目录）
④ 连 WS /api/v1/sessions/:id/stream
⑤ POST /api/v1/sessions/:id/prompt   （202 立即返回，fire-and-forget）
⑥ 等 WS 上的 done 消息；累计 usage
⑦ transcript 落 EnvironmentPaths.agent_dir
```

### 3.4 四个实测得出的关键点（全部有码可依）

| 点             | 结论                                                  | 依据                                                                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **鉴权**       | **不需要 token**                                      | `auth.ts:89-92` 只信真实 loopback 源 IP（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`）即放行；`/api/v1/health` 更是免鉴权（`auth.ts:87`）。adapter 在容器内发请求 ⇒ 天然 loopback                                                                                     |
| **cwd 白名单** | **用任务目录当 daemon 的 cwd 即可**                   | `server.ts:147` `daemonRoot = process.cwd()`；`workspace-guard.ts:26-27` `isCwdAllowed` = `isWithin(cwd, daemonRoot) \|\| isTrusted(cwd)` ⇒ 整个任务目录自动在界内，无需配置信任                                                                               |
| **权限档**     | **必须 `MIPHAM_DAEMON_PERMISSION=bypassPermissions`** | `server.ts:66-71` 合法取值 `default`/`acceptEdits`/`plan`/`bypassPermissions`；`server.ts:76-77` 注释载明 **`default` 档会把 Bash/Write/Edit 挡住**而非自动批准。容器即隔离边界，与 muse 用 `--yolo` 同理。**不设 = 每题必挂**                                 |
| **完成信号**   | **只有 WS 的 `done`**                                 | `SessionStatus = 'active' \| 'idle' \| 'compacting' \| 'closed'`；`idle` 仅在 `worker-pool.ts:116` 的 `stopWorker`（显式停止）或空闲超时出现 —— **正常回合里状态一直是 `active`**。`server.ts:533-534` 注释写明「立即返回，结果流给已连接的 WebSocket 客户端」 |

### 3.5 风险：容器内没有 WS 客户端

容器运行时画像（实测）：Debian 12 bookworm，**python3 3.13.15 + pip3，无 curl/wget/git/node/npm/bun/rg**，且 amd64 在 arm64 上跑模拟。

python3 标准库**没有** WebSocket 客户端 ⇒ 需手写一个极简 RFC6455 客户端（仅处理文本帧，约百行；客户端帧需掩码、服务端帧不需）。**这是方案 1 唯一的真实成本，须在计划里单列一步。**

备选（**不推荐**）：退回轮询 `GET /messages`。代价不是「慢一点」，而是**没有可靠的回合结束判据** —— 只能靠「一段时间没有新消息」这类启发式，会同时引入漏判（提前收工）与误判（空等）。

### 3.6 顺带白拿

`ServerUsageMessage { type:'usage', inputTokens, outputTokens }`（`attach-protocol.ts:35-40`）⇒ **每任务 token 是协议取来的事实，不是估算**，直接满足 ROADMAP 第 3 条披露。

另：`ServerToolResultMessage.isError`（`attach-protocol.ts:33`）即 T12 刚打通的成败位 ⇒ adapter 可顺带统计每任务工具失败数，作为**归因**材料（分清「模型没做出来」与「权限层把工具吃了」）。

### 3.7 模型端点与凭据

发布模型 = **`deepseek-v4-pro`**（`constants.ts:105` `baseUrl: https://api.deepseek.com/v1`，
`apiKey: '${DEEPSEEK_API_KEY}'`）。

**密钥不进配置文件，进环境变量。** `${DEEPSEEK_API_KEY}` 由 `openai-compat.ts:392` 的
`resolveEnvTemplate` 在**运行时**从 `process.env` 解析 —— 即 **daemon 进程自己的环境**。
缺失时它只往 stderr 写一行 `⚠ ... but that environment variable is not set` 并**返回空串**，
**不抛错** ⇒ 表现为「鉴权失败」而非「没配密钥」。排查时须知道这条，否则会去查错的层。

故 adapter 照 Harbor 既有范式（`muse_code.py` 的 `META_API_KEY`）：
宿主 `self._get_env("DEEPSEEK_API_KEY")` → `--ae DEEPSEEK_API_KEY=...` 转发 → 注入 daemon 环境。

**密钥来源与处置**：存于宿主本地 `secrets.sh`。`self._get_env` 先查 `--ae` 传入的
`_extra_env`、再查 `os.environ` ⇒ **运行前 `source secrets.sh` 即可**，实现代码里
**只出现变量名、不出现值**。密钥不落库、不落日志、不进 transcript（`CLAUDE.md` §二）。

**可达性已实测**（容器内，python socket）：`api.deepseek.com:443` ✅ **TLS 1.3 / 0.96s，
国内直连、无需代理**。对照 `api.anthropic.com:443` ❌ 不通（须经 `host.docker.internal:7897`）——
**这正是不选境外模型的原因**：可复现性不该依赖一条代理链路。

---

## 四、测量口径与诚实披露

口径：**pass@1、k=1、10 题**。

### 4.1 五条强制披露

ROADMAP 的四条，加本轮新增一条：

1. 这是 **scaffold 成绩**，不是模型裸能力
2. 报的是 **pass@1**，非 pass@k
3. **每任务 tokens 与成本**（来源：WS `usage` 消息，协议事实）
4. **复现命令 + seed**
5. **（新增）模型闸门结论** —— 已验**失败**：自家四个微调在本地 Ollama 上均不产生
   `tool_calls`（§1.4），故基准配 `deepseek-v4-pro`。**「为什么不用自家模型」本身就是要披露的
   内容**，不能只写「用了第三方」而隐去原因 —— 隐去即等于把一条负面事实伪装成中性事实

### 4.2 选题规则（不预筛）

**规则：按数据集任务目录名的字典序，取前 10。** 规则**先于任何结果**确定，不含人工判断 ⇒ 结构上无法挑题。

这条不是形式主义：T2 全部价值建立在「可复现」上，而**任何按结果反推的选题都会让它当场失效** —— 读者无法分辨这是成绩还是筛选。若最终确实改用人工挑选的题集，**必须在披露里写明**，否则该数字与全量不可比。

---

## 五、交付物

| 交付物    | 位置                                                  | 备注                                                                                                    |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 适配器    | `benchmarks/harbor/mipham_code.py`                    |                                                                                                         |
| 复现脚本  | `benchmarks/`                                         | 固化 `harbor run` 参数                                                                                  |
| 结果 JSON | `benchmarks/`                                         | 原始结果，可复查                                                                                        |
| README    | 仓库根 `README.md`                                    | 复现命令 + 选题规则 + 五条披露                                                                          |
| 产品页    | `../websites/domestic/`、`../websites/international/` | **父仓子模块，按 §十五 规矩走**：在各自仓库内开发提交推送，父仓只更新 gitlink。**不在父仓改子模块文件** |

---

## 六、闸门与未决

| 项                     | 状态                   | 影响                                                                                                                                                                                                   |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **模型闸门**（已关闭） | **已验，失败**（§1.4） | 不阻塞设计；**曾阻塞「发布配哪个模型」** ⇒ 已按失败分支处置（配 `deepseek-v4-pro`）。原备的云端探针脚本（`/tmp/mipham-probe.mjs`）**因前提不成立而作废** —— 云端并不服务这四个模型，没有对应的密钥可配 |
| **成本上限**           | 未定                   | 10 题 × k=1；token 量由 WS `usage` 消息给出（§3.6），是协议事实而非估算                                                                                                                                |

**闸门两分支**：通过 ⇒ 自家模型发布（故事完整）；不通过 ⇒ 回落第三方，**并把这件事本身写进披露**。

**本轮走的是失败分支。** 须注意这不是「暂时没配好」—— 是**能力天花板**（§1.4），
披露里必须如此陈述，不可软化成「未启用自家模型」。

---

## 七、局限声明

1. **本 spec 不含 daemon 修复的实现细节**（具体函数签名、隐藏子命令命名）—— 那属计划层。
2. **§3.5 的百行 WS 客户端是估算**，未实测容器内可否用 pip 装 `websockets`（容器可联网走代理，但该路径未验证；手写是**不依赖网络**的那条）。
3. **10 题 spike 的结论不可外推为全量成绩** —— 选题规则的偏差、以及小样本方差，都使二者不可比。
4. **`om-v5-pro` 的工具能力已定，是否定的**（§1.4）。原文的推理依然成立 ——
   「协议层无能力闸门」（`openai-compat.ts:26` 无条件转发 `req.tools`）⇒ 是否认 tools
   **由服务端/模型决定，代码里读不出来**；本轮把它**实测掉了**：转发是真的，对方收了也不调。
   **已非未决项。**
5. **本 spec 覆盖两条工作流**（§二 daemon 修复、§三 adapter），实现计划阶段应**拆成两份计划**或一份计划两个显式阶段 —— 前者先行、独立提交，后者依赖前者。二者唯一的硬接口是 §2.2 的 cwd 继承契约。
6. **「密钥获取」一节的结论已被推翻**（保留作为一处**已证伪的推理**的记录）——
   原写「闸门因无 MiphamAI 密钥无法关闭、钥匙须由引擎侧签发」。实情是：四个模型未上云
   ⇒ **不存在对应的云端密钥**，闸门与密钥**无关**（§1.4）。
7. **`secrets.sh` 的值不进入本 spec、也不进入实现** —— 发布用的 deepseek 密钥存于
   宿主本地 `secrets.sh`（用户确认）。设计上只声明**来源**，运行前由使用者
   `source` 进环境，adapter 经 `self._get_env` 从 `os.environ` 取。**密钥不落库、不落
   transcript、不进代码**（`CLAUDE.md` §二 硬约束）。
