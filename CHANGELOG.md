# Changelog

All notable changes to Mipham Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 0.68.0 之后的条目于 2026-09-14 依据 git 提交记录回溯补全（标签日期为准）。

## [0.85.6] — 2026-09-26

### Added

- **`--provider` / `--model` 顶层 flag** —— 两个**已发布**的 IDE 插件在本笔之前根本起不动 CLI：
  VS Code 的 `buildFlags()` 与 JetBrains 的 `buildCommand()` 都从插件设置拼
  `mipham --provider <id> --model <id>`，而这条命令的回答是 `Unknown command: mipham deepseek`
  （rc=1）。原因不在解析而在**次序**：`--provider` 不在 `VALUE_FLAGS` 里 ⇒ 它的值落进位置参数 ⇒
  撞上 `detectUnknownArgument` 的未知命令分支，而那个分支跑在所有 flag 解析**之前**（只加解析、
  不补那两张表等于什么都没修）。`RunOptions` 一路都有 `provider?`/`model?`，入口那行也早写着
  `options.provider || config.defaultProvider` —— 缺的只是调用点。值**原样使用、不校验是否已注册**
  （与 `--permission` 有意不同：provider 可由用户自定义，静态白名单必然误拒），不认识的 id 由注册表
  在首次发消息时点名，与同一个值来自 `config.yml` 时逐字一致；只给 `--model` 时沿用当前 provider，
  CLI 不替它猜归属。
- **公开面的计数立真源** —— 产品页页脚那个测试数**至少被手改过 7 次**
  （2262→2266→2388→2560→2891→2935→2962→3473），而最后一次改动当天真值已是 3,486 —— 手改版数字的
  期望寿命比两次发布之间的间隔还短。`package-info.json` 新增四个槽（`SLASH_COMMAND_COUNT` /
  `PROVIDER_COUNT` / `TOOL_COUNT` / `TEST_COUNT`）+ 三处落盘副本，两站页面**一个数字都不再持有**。
  三道机器判据：树守卫（落盘值 vs **进程内**真源）＋ i18n 副本的**真值**判据 ＋ **CI 硬门禁**
  （套件自报 `numTotalTests` ≠ 落盘值即红 —— 它守的是**对不对**，树守卫守的是**一致**）。

### Fixed

- **`mipham update` 的安装换成原子换手 —— 半截树按构造消失** —— 旧流程是「装前快照 →
  `npm install -g` 就地重写 → 装后自证 → 失败回滚」，而 `npm install -g` **没有原子换手**：中途被杀
  （超时 / Ctrl-C / SIGKILL）就落在「旧树已删、新树没写完」上 —— 机器上**连一个 `mipham` 都没有**，
  连用来重试的 `mipham update` 也一起没了。现在装进 `<prefix>` **内部**的 staging 目录（必须同一
  文件系统；落 `os.tmpdir()` 在 Linux 常因 tmpfs 报 `EXDEV` ⇒ 只能退化成拷贝，那正是要消灭的那个
  可中断中间态）→ 在 staging 上跑两道自证 → **两次 rename**（旧树挪走、新树就位）→ 换手后再验一次
  → 清理。窗口从分钟级的「写了一半」缩到 **µs 级**。**回滚一律走反向 rename**，拷贝式快照整套退役；
  失败文案从 `rolledBack: boolean` 二态改成 `untouched | restored | broken | unknown` 四态 ——
  最常见的失败（staging 装不上）里旧树**从未被碰过**，说「无法恢复原安装」是对用户机器的假陈述。
- **Windows 下每次 `mipham update` 都把刚装好的版本回滚掉** —— `npm` 在 win32 下把全局包装进
  `<prefix>/node_modules`（**没有 `lib` 这一层**）、bin shim 落在 `<prefix>` 本身，而旧代码把 Unix
  的四层 `..` 用在两个平台 ⇒ Windows 下 prefix 多退一层、launcher 指向一个永远不存在的文件 ⇒
  自证的第二道门（真跑 launcher）必失败 ⇒ **Windows 用户永远升不上去，而且每次都被告诉「失败」**。
  同一处**还跳过了对照物检查** —— 正是该分支文档写着「绝不猜」的那一格。平台改成可注入参数，两条
  布局分支在任何机器上都能真跑。**为什么活到现在**：那半直接读 `process.platform`，在开发机与 CI
  （都是 Unix）上永远跑不到。
- **调用方的撤销从来没有到达传输层** —— `ChatRequest.signal` 有声明、有消费者、有设置者，唯独没有
  **送达者**：两个 provider 的 `fetchWithRetry` init 里都没有 `signal` 字段 ⇒ 那个 `AbortController`
  **一次都没接上过**，而 `abort()` 在无人监听的信号上是空操作（`critique()` 文档承诺的「超时返回
  null」因此从未生效，真兜底的是 provider 自己的 90s 流空闲超时）。补上送达之后**不能只补这一行**：
  `fetch-utils` 的 `finally` 撤的是它刚交给 `fetch` 的组合信号，而调用方是在函数**返回之后**才读
  body 的 ⇒ 每个流都会在响应头处被自己掐死。改用 `AbortSignal.any`（对源信号持弱引用，组合在
  body 读取期间保持活着、又不需要任何清理）。
- **消费方走人时那条连接从未被放开** —— 两个 provider 的流式读循环通篇没有 `reader.cancel()`，
  而消费方**确实会中途离开**（引擎收到 `stop` 块即 break；子代理在 abort 时抛）。逐个出口补只覆盖
  读循环自己知道的那几个，覆盖不了「消费方半途走人」—— 而那正是这条路日常发生的形态。故把**读循环
  连同它后面兜底的 `stop`** 一起包进 `try/finally`。
- **ghost-text 补全：上行没有上限、下行取消不掉** —— 取消判据原在循环**外**（该在的地方是循环
  **内**，每块判一次）：判在外面等于**先把整条流读完再丢结果**，用户每次 >400ms 的停顿都买一个完整
  completion。上限原只限**条数**（6 条），而一条 `content` 可以任意长 —— 贴进来一个文件，6 条就是
  上万 token；现在每条**留尾**截断到 2,000 字符（续写要看的是「刚说到哪儿」，故砍头）并标出截断。
  另补接线层测试：纯函数早已逐条钉住，但 `test/ui/` 里**一条都没碰过 `InputBar`** —— 纯函数绿推不出
  「Tab 真能把建议并进正文」。
- **`--resume` 后上下文估值被单条系统提示覆盖** —— 恢复时先按「系统提示 + 全部消息」算估值，紧接着
  又只按系统提示重算一遍 ⇒ **整个消息部分被覆盖掉**，而 `needsCompaction()` 读的正是这个字段 ⇒
  恢复一个长会话后压缩迟触发、上下文越滚越大才动手。估值只该有一处推导，那份手写的第二算法已删。
- **子代理声明的 `memory` 从来没到过模型手里** —— 它被拼进了子代理自己的上下文，可紧接着又用
  **没拼记忆的那份**设了一遍，而请求那一行读的是那个局部变量 —— 于是 `memory:` 在定义里写着、在
  `/agents` 面板里显示着，跑起来一个字都到不了模型手里：上下文里没有、请求里也没有。现在拼接规则
  只此一处，请求改读组装好的那份。
- **读侧不验形：同族残留在别处又长了一遍** —— 写侧那一族早已收口，**读侧那一半没修**：
  `JSON.parse(readFileSync(...))` 的结果被直接当声明类型用。危险的是「**合法 JSON、错的形状**」
  这一格 —— 它不抛，所以 `catch` 兜不住、也没有别的东西会说话。五处：梦历史（`{"a":1}` 被当数组
  返回，调用点 `.length` 直接 TypeError 冒到 UI）、错误签名库（`["x"]` 被照收 ⇒ 库里躺着一个没有
  id 的成员，而统计的分母还算上它）、有效性台账（`Object.entries` 把**下标**当键）、记忆链接图
  （`new Set("bc")` **按字符**迭代 ⇒ 一条链接被拆成两条）、召回统计（`catch` 在循环外 ⇒ 一条脏记录
  赔上后面所有条目）。
- **页脚把启动那一拍的 graft 状态冻死** —— `useState(() => findGraftStats(cwd))` 的初始化函数只跑
  一次，而那个文件是**别人在后台写的**：启动正好撞上重建就永远挂着 `syncing…`，磁盘上早已
  `syncing: false`。改成按拍重读，且只在校验过「真变了」时才换 state（否则每秒一次 `setState` 会把
  整棵树重渲染）。该文件的文档注释原本把这个冻结**当成设计写下来**了 —— 注释替缺陷背了书。
- **`daemon.log` 有了上限** —— 日志只增不回收，一个反复起不来的 daemon 会把这块盘写满。现在在
  起手处（mkdir 之后、open **之前** —— 那是唯一「没有写者」的时刻）轮转，**改名而不是截断**：这个
  场景真正要留的恰恰是上一代（一个反复起不来的 daemon，前一次留下的就是全部线索），只留一代 ⇒
  上限恒为 2 × 5 MiB。同目录下另一个无上限的追加型 sink（`permission-audit.jsonl`）**刻意不动**：
  审计台账静默丢行是策略决定，它的价值在全集、不在尾巴。
- **daemon smoke 的两条守卫分支此前零执行** —— 就绪检查用的是 `grep -q`，而它在首个匹配即退出、
  `set -o pipefail` 下生产者的 SIGPIPE(141) 被读作「无匹配」⇒ 删除侧会把活着的 daemon 读成已停
  （正是那道闸要防的删除）。统一改成「捕获输出 → case」，并新增三个用例驱动**同一个脚本**（含
  `ok` 正对照 —— 否则「红」分不清是脚本坏了还是守卫永不通过）。首次真跑：两条分支本身是对的，
  缺的不是正确性，是从没有人跑过。超时分支另修真缺陷：放弃前再探一次状态（截止时间是预测、不是
  事实，恰好压在线上就绪的 daemon 不该被杀），确实没起来则回收它自己起的子进程。
- **`/code/docs` 的示例配置教用户写 `permission: auto`** —— `auto` 合法但语义是**分类器档**（只读
  工具绕过判定直接过），而产品默认是 `default` ⇒ 样例比默认**更宽**，与根 `README.md` 里修掉的那行
  **同形状**；同一份样例还把版本硬编码成 `version: "0.2.2"`。修法**不是**把 `0.2.2` 改成当前版本
  —— 硬编码正是它会烂的原因，同一页里早有从构建期常量派生的写法。**诚实的边界**：本笔只让仓库里的
  页面正确，线上何时更新是另一步。
- **产品页把命令数写成 85（真值 137）** —— 少 52。这一条主张在**两份副本 × 两种语言**里各有一份，
  四处八行一并订正；改的是**拷贝**、不是站点（按对象扫全文件，不按短语改）。
- **两份 i18n 副本各带着对方的死重** —— shared 596 → 92、CLI 831 → 745、**共有键 586 → 0**
  （改前 590/1427 = 41% 是死的）。重复**按构造消失**，并补上**真判据**的守卫：把每个 `t(` 调用点
  逐个分类、认不出的形式即红。旧守卫那条「共有键的值必须相等」**是错的判据** —— 它抓不到本批那笔
  真错值（4 个文件曾**同时**写着 `85`、真值 137，两份是同一个错值 ⇒ 值相等只会全绿）：
  **两份相等证的是两份一致，不是两份对**。

测试 3,426 → 3,506（291 → 299 文件，0 失败）。

## [0.85.5] — 2026-09-25

### Fixed

- **目标读不出文本的递归 `rm` 一律拒绝** —— 安全检查读的是命令**文本**，而文本说不出要删什么时，
  它一路放行。四类新增：目标只有命令替换输出（`rm -rf "$(pwd)"`）、变量后跟一个根级目录名
  （`$VAR/usr` —— 变量未设置时不是报错而是被丢弃，留下 `/usr`）、锚在工作目录变量上
  （`$PWD`/`$OLDPWD`）、以及只有反斜杠。词法切分带引号感知（空格切分下
  `"$(git rev-parse --show-toplevel)"` 会裂成三个 token，而带空格的正是要抓的那一类）。该闸排在
  放行规则与各档基线**之前**：放行规则、auto 分类器、`bypassPermissions` 读的都是同一段文本，
  看不出差别 —— 所以 **auto 下不会去问分类器**（问的是同一份缺失的文本）。豁免走环境变量
  `MIPHAM_DISABLE_DANGEROUS_RM_PROMPT=1`，**不走工具参数**（参数是调用方能关的开关）。拒绝文案
  说明它覆盖的是**结果**、写明 `/permissions` 抬不动它，并点名目标。
- **服务端 `Retry-After` 不再被无上限信任** —— `3600` 曾把 CLI 按进 sleep 一小时、屏幕上没有任何
  可取消之物；`0` 让重试背靠背；不可解析的值经 `parseInt` 成 `NaN`、而 `setTimeout(NaN)` 读作 0
  —— 与前者同形，但**无声**。现在按 [1s, 60s] 夹取，不可解析一律退回指数退避。
- **插件声明的落点：远端 MCP 不再被静默丢弃** —— `mcp-servers/*.json` 的装载门要求 `command`，
  而 `command` 与 `url` 本是两种互斥的传输 ⇒ 每个用 `url` 声明的远端服务器都被丢掉，**一句提示
  都没有**：插件看着装好了，它的工具就是不出现。装载门改为「任一传输」并在跳过时点名文件与
  server；`validatePlugin` 新增 `warnings`（不阻断安装）：会被丢弃的声明、无替换步骤的
  `${user_config.*}`、明文 `http://`（回环豁免）—— 且「会不会被丢弃」由**装载器自己那支判定
  函数**回答，不另抄一份（抄的那份漂移了，读到的就是校验器的答案，而它已经不对了）。
- **插件钩子不再是匿名的** —— 插件注册的钩子与操作者自己在 `settings.json` 里写的那批此前完全
  同形，三处后果一处比一处重：① 失败文案不说是谁的（插件的命令通常是 `sh`/`node`/插件根下的一条
  路径，**没有一个能当成名字去查**）；② 健康键只取事件 ⇒ 同一事件上的两个钩子**共用一个失败计数
  与一个禁用位**，一个坏钩子连挂 5 次会把它**从没失败过**的邻居一起自动禁用；③ 卸载按事件扫 ⇒
  **删掉插件 A 会连带删掉那些事件上的每一个钩子**，包括操作者自己的。现在注册带来源、失败文案
  点名 `from "my-plugin"`、健康键并进来源、卸载只删这个来源声明的那些。**无来源的一切逐字不变**
  —— `/hooks enable "<key>"` 吃的就是那些字符串，给插件加维度不能让没有插件的钩子改号。
- **`mcp_tool` 钩子不再是空壳** —— `HookType` 列着它、`HookConfig` 备好了 `mcpServer`/`mcpTool`
  两个字段，而执行器匹配到这个 case 就 `return { allowed: true }`：操作者的 settings 写着自己在
  被守着，实际什么都没跑。现在真调用（事件上下文作为参数）、按命令钩子 stdout 的同一份契约判读，
  并按钩子点名的 server/tool 等连接落定（上限即握手自己的超时）：到点仍未落定就如实说「仍在连接、
  工具未调用」，而不是拿「尚未连接」冒充「不在」。`isError` 只如实报告、**不当成 deny** —— 它
  意味着这次调用**没说话**（服务器不可达报的是同一个形状），当裁决就等于让每台连不上的服务器静默
  变成一次拦截。
- **被截断的一轮不再装成写完** —— 流若没走到 `message_stop`（代理或网关把连接干净地关掉，字节流上
  与正常收尾一模一样），`truncated` 就从函数末尾那个**不带这个标记**的出口出去了 ⇒「撞了输出上限」
  与「被中途切断」两种不完整，都读成正常写完。现在补一个「是否到过终止事件」的状态，没到过即不完整，
  并在放行 stop 前出一条警告（TUI 早已渲染 `⚠`）。
- **重放的流事件不再跑两次工具** —— 同一个 `content_block_stop` 被代理补发时原先会发两次
  `tool_use`，引擎就**跑两遍工具**：两次写入、两次提交、两次这个工具做的一切。现在按块 id 去重
  （不同 id 仍各发一次）。
- **工具轮次上限改成「一轮对话的预算」** —— `MAX_TURNS` 是**函数内常量**，而 Stop 钩子每拦一次就
  重新发一整份 100 轮 ⇒ 一个永远不满足的 Stop 钩子（例如「测试不过就别停」，而模型修不好）会让
  这一轮**永不结束**。现在剩余轮次一路传递、归零时 `block` 不再换来新的一轮；**被驳回要说出来**
  —— 预算用尽时出一条警告带上钩子自己的理由，而不是静默忽略（悄悄不执行的钩子比被告知越权的钩子
  更坏）。钩子本身没有被削弱：拦一次就放行的钩子照旧续跑一轮、且不产生任何提示。
- **会话中途目录被删掉之后，工具不再拿着一个不存在的目录去跑** —— 启动时目录已经不在有闸接住，
  **跑着跑着**被删则没有任何一层发现；而「运行时自己会报」这件事**不成立**，且两种运行时还不一样：
  Node 从**碰它的那个调用点**抛、消息点名的是别的东西；Bun（本仓库首选运行时）**根本不抛**，一直
  返回启动时缓存的路径，于是被删的目录作为一串**完全普通**的字符串交到工具手里，直到第一次系统调用
  才炸，而那时的错误点的是**先被碰到的东西**（实测 `spawnSync /bin/echo ENOENT`：怪的是 `echo`，
  一个字都没提目录）。现在判据交给文件系统（取路径 + `existsSync`），两种运行时同一个答案；工具
  不跑，结果写明「这个会话的工作目录已不存在、请从存在的目录重启会话」。
- **恢复会话时收尾没有结果的工具调用** —— 盘上的日志可能以一条**没有结果**的调用收尾（写盘写到一半
  被打断，末尾那条结果被丢、调用留在盘上），而 provider 整条拒收这种历史 ⇒「这次的调用没收尾」在
  用户那里表现成「恢复之后说的第一句话就报协议错」。现在补一条「结果未知」的事件，正文给出下一步
  （先去查证，别猜成功也别猜失败）—— 补成**事件**而不是往投影里塞一条消息：本仓库的不变量是
  「模型看得见的必须已记录」，凭空出现的消息正好违反它。
- **同名 MCP server 并发连接合并** —— 启动时两条来源是**并发**的且都不 await，而 `connect()` 只把
  `status === 'connected'` 当「已经连上」⇒ 撞上同一个名字时，第二条会**另起一条传输**，被换掉的
  那条连同它的 stdio 子进程一起没人关（`closeAll` 只遍历 `connections`）。现在同名握手在途时合并到
  同一次，`finally` 里无论成败都放开这个名字 —— 失败之后重连要能真的重连。
- **一次刷进来的按键不再作用在上一行选择上** —— 一组按键会在同一个 chunk 里到达（远端 / 远程控制，
  或键盘把「↓ 然后 Enter」一起写进来），而 React 还没提交第一个回调里的 setState，第二个回调拿到的
  就还是**上一张闭包**：**「↓ Enter」按在按下 ↓ 之前那一行上**。修法是给光标加一条**同步镜像**
  （`useKeyState`）：`value` 只给渲染，判据一律走同步读数，同一个 burst 里的多次修改还能**叠加**。
  模型选择器（provider 级与 model 级）、命令选择器、首装向导三处一同收口。
- **命令选择器一次 Enter 不再提交两遍** —— 有两个监听者都在处理 Return（组件自己的 `useInput`
  与输入框的 `onSubmit`），`onSelect` 被调用**两次** ⇒ **一次按键，命令跑两次**（单按一次 Enter
  即复现，与 burst 无关）。现在 Enter 归组件自己的 `useInput` 管，职责只有一处。

### Added

- **启动时提示指令总量** —— 指令装载链只报告**缺**（空目录提示），从不报告**多**；而多不是靠
  「某个文件很大」长出来的：三层指令、逐目录的规则文件、教训召回块各自都不大，加起来照样把工作挤走
  —— 按单文件设阈值看不见这种形状。现在按**真正发出去的那份投影**计数（已被 `prompt-exclude` 剥掉
  的段不计，两份数字不会分叉），合计越过 40,000 字符时说一句：阈值只作用于**合计**，没有单文件阈值
  （那正是本条要治的形状）。

测试 3,298 → 3,426（271 → 291 文件，0 失败）。

## [0.85.4] — 2026-09-24

### Fixed

- **`/permissions` 拒绝它自己叫你敲的那个拼写** —— denial 文案印 `/permissions allow "Bash"`，
  照它敲 `allow "Git"` 却回 `Invalid rule ""Git"": not a single tool name.`：`positional[1]`
  **原样**当规则用（引号跟着一起进了规则名），而所有印它的地方都印**带引号**的写法；
  `allow "Git" "Bash"` 里第二条（`positional[2]`）**全程没人读** ⇒ 静默丢弃。现在 verb 之后的
  规则按**引号**重切、逐条校验、逐条落盘。并配一条 **meta-test**：从真 denial 文案里正则抠出
  那条该敲的命令再拿去执行 ⇒ 文案与命令一分叉即红。
- **auto 分类器的输出上限与模型的「思考」共享** —— 请求写死 `maxTokens: 200`，而真模型实测
  （`deepseek-v4-pro`，三次真调用）~880 字符 reasoning 就吃光预算 ⇒ `finish_reason=length`、
  可见文本 **3/3 全空** ⇒ 三次全被判「读不出来」挡下 —— **越该裁决的调用越必然饿死**，方向正好
  反了。且 `chunk.truncated` 从没被读 ⇒ 「被上限截断」与「答复不清」同形。现在去掉该上限（走
  provider 默认），并读 truncated 在理由里如实点名。

测试 3,288 → 3,298（271 文件，0 失败）。

## [0.85.3] — 2026-09-23

### Added

- **`--permission <mode>`** —— 这个选项一路都在（`RunOptions.permission`），只是**没有任何调用点
  传过它**：非交互场景从前只能靠 `MIPHAM_DAEMON_PERMISSION`（daemon 专属）。现在
  `mipham --permission plan` 启动即 `plan` 档。
- **`settings.json` 的 `permissions.defaultMode`** —— 档位的门多了一扇，规则一句话可复述：
  **天花板只能由操作者自己的文件移动**。优先级 `--permission` > 用户级 `settings.json` >
  用户级 `config.yml` > 内建 `default`；**项目级的 `.mipham/config.yml` 与 `.mipham/settings.json`
  不是门** —— 它们跟着代码一起来（clone 一个仓库不等于被它代授一个档位），写了就拒、并在 stderr
  点名那个值与路径。

### Fixed

- **系统提示里的权限段冻在启动时** —— `buildSystemPrompt(permission.getMode())` 只在建 prompt
  那一刻为真，Shift+Tab 之后**没有任何地方重设** ⇒ 往宽切档时闸门开了、模型手里的指令还是旧的
  （它会拒绝做**已经允许**的事）。现在由 `ContextManager` **读时派生**，缝留在上下文层 ——
  那正是「谁被顺带改变」的边界（daemon 的 ContextManager 本就不设系统提示）。
- **子代理从不知道自己处在哪一档** —— 它的提示是按 agent 定义拼的，从不含权限段。现在报**它
  自己的**档（读闸门的**结果**，不是定义里那个字符串：组织级 `maxAllowedMode` 会静默钳走），
  且必须落在**真正发出去的那份提示**上 —— 挂错地方的接线是装饰，请求里一个字都到不了。
- **remote attach 时切档什么都不发到线上** —— 页脚在本地、闸门在 daemon，`set_mode` 之前一个字
  都不过网。
- **四条报告面报的是配置里的替身** —— `/status`、`/doctor`、`/stats` 与 `/setup` 的状态面板读的
  都是 `config.permission`，而配置文件只是几扇门里的一扇（Shift+Tab、组织级钳制、用户
  `settings.json` 都会移动真正生效的那一档）⇒ 它们可以点名一个**不是**正在拒绝调用的档。现在
  它们读引擎所在的档。`/config` 的 `permission:` 行与 `/setup 5` 的两值并陈**有意保留**：前者
  是配置文件转储，后者本来就是教这两者会分叉的地方。

测试 3,231 → 3,288（271 文件，0 失败）。

## [0.85.2] — 2026-09-23

### Security

- **路径型权限规则按字面拼法判定 —— 一个符号链接就能把它抹掉，deny 与 allow 两个方向都中**
  `Read(**/.env)` 从前只看模型发来的那条路径拼法。`notes.txt` 是指向 `.env` 的符号链接时，
  「读 notes.txt」就是「读 .env」，而规则看不到 ⇒ 一条 deny 被一个 `ln -s` 抹掉；Bash 的
  `cat notes.txt` 走同一条文件访问分支，同样漏。**allow 方向是同一个洞的镜像，方向相反**：
  一句 `"allow": ["Read(**/*.txt)"]` 会把一个指向 `.env` 的 `.txt` 链接一并**静默放行** ——
  allow 即 bypass，终端里连弹窗都没有。判定现在按**落点**（`realpathSync`）再判一次，两侧都落在
  安全的那一边：deny/ask 补上只会多命中（fail-closed），allow 补上只会少放行。
- **MCP OAuth 凭证只按「服务名」复用** —— `TokenStore` 只按名字存（`<name>.enc`），而这个名来自
  `.mcp.json`、那是**从 cwd 读**的项目级配置：clone 一个仓库就等于让它给你的 MCP 服务起名。于是
  「名字相同」推不出「签发方相同」—— 把某个常见名的 url / tokenUrl 指到别处（或由克隆来的仓库
  直接这么写），缓存里那份真凭证就被送去新的主机。凭证现在带**绑定值**，端点等任一要素变化即
  视为新授权方、重新授权。
- **隐藏字符剥离删过头 —— 写盘路径静默改写用户文件内容**（这是我们自己上一批埋的）
  `DANGEROUS_UNICODE` 的零宽段写作闭区间 `\u{200B}-\u{200F}`，把区间内的 U+200C（ZWNJ）与
  U+200D（ZWJ）一并吞掉。这两个是**承重**字符、不是藏字手段：ZWNJ 黏住波斯/阿拉伯语后缀
  （实测一个含 ZWNJ 的 6 字符词形被剥成 5 字符），ZWJ 是把家庭 emoji 的三个码位黏成**一个**
  字形的方式（剥掉会散成三段）。两者已移出剥离集合 —— 该集合的目的是「不让人用不可见字符藏
  指令」，而这两个在**执行层没有可藏之处**（实测 `bash -c 'ec<ZWJ>ho hi'` ⇒ `command not found`）。

### Fixed

- **半截写赔上全部状态** —— 这一族的形状是「非原子写 + 读侧把读不动兜成空」：`writeFileSync`
  写到一半被杀（SIGKILL / 断电 / `timeout` 到点）留下半截 JSON，而读侧一句
  `catch { /* corrupt — start fresh */ }` 把它当成「文件损坏」直接清空 —— 一次崩溃赔上**全部**
  规则 / 签名 / 统计 / 记忆，不是丢一条。25 个模块收口到原子写，读侧加**形状闸**（合法 JSON
  不等于合法形状），并留两份**两向**守卫（裸写清单、FIFO 接线探针）拦住这一族再长回来。
- **配置路径上是 FIFO 时启动挂死** —— `existsSync` 对 FIFO / socket / 设备节点 / 目录**一律为
  真**，而 `readFileSync` 读一个没有写者的 FIFO 会**同步**阻塞到有写者出现：一条
  `mkfifo ~/.mipham/config.yml` 就能让 CLI 启动永久挂住 —— 没有输出、没有报错，也没有任何东西
  能给它计时（阻塞发生在同步调用里，定时器与 signal handler 都排不上队）。闸门改按**文件类型**判
  （新增 `shared/regular-file.ts`；用跟随符号链接的 `statSync`，所以软链进 dotfiles 仓库的配置
  照旧可用）。
- **Ctrl+C 在对话框里误按一次就杀掉整个 CLI** —— 密钥提示 / 模型选择器开着时，Ctrl+C 的合理语义
  是「停下手上这件事」，实际行为却是直接退出，输入框里的半句话与当前会话一起没。根因不在我们的
  分支写得对不对，而在**它根本跑不到**：Ink 的 `exitOnCtrlC` 默认为 `true`，在按键**到达任何
  handler 之前**就退进程。现在对话框自己接管这一格。
- **hook 没能跑完时理由无处可归** —— `spawnSync` 对「起不来 / 跑不完」**不抛**，它把成因放在
  `result` 上：超时是 `ETIMEDOUT`，命令不存在是 `ENOENT`，被外部信号杀死是 `status: null` +
  `signal` 而**根本没有 error**。三者的 `stderr` 全是空的，于是都落进同一条分支、产出**逐字相同**
  的空理由。三种形状现在各自可归因。**同族第二笔**：给它喂 stdin 的那次写入会与子进程退出**赛跑**，
  输了带 `EPIPE`，而它排在退出码与信号**之前**被读走 ⇒ 把我们自己的写失败**顶替**了子进程真实说
  的（`Hook warning: boom` 被改写成 `Hook error: … EPIPE`）。
- **发给后台 agent 的消息从来没送到** —— 它被三处广告为可寻址：`agent` 工具的输出印着
  `taskId="bg-…"`，`SendMessage` 的描述写着「a background task ID for same-process agents」，
  路由器认这个前缀并返回 `success: true`。而全仓 `poll(` 只有一个调用点、收件人又只认
  `[sessionId, 'main']` ⇒ **没有人读那个地址**。地址交接与每回合自排空两半都补上（缺一即失效）。
- **子代理没有断环器** —— 引擎早有「连续被拒 3 次就把『换个做法』挂进拒信」的熔断，子代理那条
  自写的循环对它**零引用**，而它只有 5 轮且没人可问 ⇒ 被拒的调用一轮轮重试，直到把整个运行耗光。
  阈值收成公共常量，两个读者不能各漂。
- **同一段对话发给两个 provider 是两个 payload** —— 引擎把上一轮 provider 的报错存成 `system`
  条目（好让 resume 渲染 ⚠ 行），而 `openai-compat` **原样以 system 角色发出** ⇒ 把**来自
  provider 的文本**提到了最高权限角色；`anthropic` 对 system 条目是跳过。system 条目现在只是
  header（仅首位、且不与 `systemPrompt` 并存）。**同笔带出一处镜像缺陷**：汇总调用**正是**用
  数组里的 system 条目发指令 ⇒ 走 OpenAI 兼容的 provider 读得到、`anthropic` 读不到（汇总退化成
  「自己看着办」）⇒ 指令改走 `systemPrompt`。
- **`Task output` / `Task stop` 只认本地 id 空间** —— 这两个 action 只查模块内的 `tasks` Map，
  它的 id 是 `"1"`,`"2"`…；而后台 id 由 BackgroundAgentRegistry 另铸。于是 Agent 工具**广告出去
  的那个 `bg-…` 调用只可能回 not found**。补上桥接（原来那条桥判的是 provider registry、又强转
  一个本就声明在 `ToolContext` 上的字段、还写在早退之后），顺带删掉**从未有写入点**的
  `Task.output` 与两个死读点 —— 那是个读一个永不被填的字段的**假入口**。

测试 3,083 → 3,188（265 文件，0 失败）。

## [0.85.1] — 2026-09-23

### Fixed

- **终端 Ctrl-C 仍能把安装打断到一半** —— 0.85.0 修好了「装前快照 / 装后自证 / 失败回滚」，
  但那套回滚跑在 **CLI 进程里**：终端按 Ctrl-C 时 SIGINT 发给**整个前台进程组**，CLI 与 npm
  一起死 ⇒ `catch` 永远不执行，用户手里还是半截树，**而且这次没有人回滚**。现在装两道守卫，
  **缺一被保下来的都只是一半**：① 安装那一步带 `detached: true` ⇒ npm 自成进程组，终端的
  SIGINT 到不了它（实测 `execSync` 认这个选项，且**仍阻塞等它退出** ⇒ 装后自证仍在装完之后；
  `stdio: 'inherit'` 下它的输出也照样打在终端上）；② CLI 在安装窗口内挂一个 SIGINT 守位
  （`finally` 撤，抛错路径也撤），好让自证与回滚有机会跑。
- **代价如实说**：安装期间 Ctrl-C 会被忽略 —— 要中断只能另开一个终端杀进程。这是本修法的代价，
  不是附带好处。两端各留一个未覆盖的窄口，各自无害：快照（复制 6601 个文件）期间按 Ctrl-C ⇒
  CLI 退出、npm 从未启动、旧树完好；自证（只读）期间按 Ctrl-C ⇒ 不再自动回滚，但树是**完整的**。
- **根因未动**：`npm install -g` **没有原子换手**，真正扛得住 SIGKILL / 断电的是「装进 staging
  prefix + 对包目录与 launcher 做两次原子 rename」，在 ROADMAP D12 上。

## [0.85.0] — 2026-09-22

### Fixed

- **`mipham update` 会把用户的 CLI 整个弄没（自锁）** —— 用户报告：发布成功后，`mipham` 从机器上
  消失，连 `mipham update` 这条用来重试的命令也一起没了。根因是**两个「各自都对」的选择相乘**：
  ① `npm install -g` **不是原子换手** —— 它先删/覆写旧的包目录，再把新的解包进去，中间有一个
  「磁盘上既没有旧版也没有新版」的窗口；② 安装那一行带着 `timeout: 600_000`（注释写的是
  「slow networks may need 7+ min」），而包是 84 MB / 6601 文件、本机链路上一次**正常**安装要
  **>11 分钟** ⇒ **计时器在正常安装途中开火**，SIGTERM 打死 `reify`，只留下被掏空的包目录和
  `<prefix>/bin/` 里一个指向不存在文件的 npm 临时符号链接。**给一个可能很慢的破坏性操作设超时，
  等于给它设一个「在某个时刻毁掉一半」的闹钟** —— 计时器开火那一刻，就是破坏本身。
  三处收口：

  - **安装步骤不再设超时**（进度由 npm 自己印在终端上，中断交由用户）；超时只留给 `npm view`
    那类**只读**的元数据查询
  - **装前快照 + 装后自证 + 失败回滚**：`resolveInstallPaths()` 先定位 `<prefix>`，并**要求
    `<prefix>/bin/npm` 存在**（真 node prefix 一定有它），否则返回 `null` —— 宁可如实说自己没能力
    验证，也不往猜出来的路径写 launcher；快照 `<pkgDir>` 与 launcher（launcher 存**包副本之外**，
    否则还原会在包里多出一个文件）；自证是**真去执行** launcher（`mipham --version`）并核对版本号，
    不是看退出码
  - 原来那句 `Run 'mipham --version' to verify` 是把唯一的检查甩给用户，而那时旧安装**已经**被毁了

  **边界（诚实说明）**：这套保护**只对已经装上它的机器生效** —— 修好之前发布的版本跑
  `mipham update` 用的仍是旧代码与旧计时器，而**它们唯一的自助升级路径恰好就是坏掉的那条**：
  等到 10 分钟会被计时器砍，中途 Ctrl-C 同样砍在 `reify` 中间，两条路留下的是同一个半截树
  ⇒ **升级到本版请直接用 `npm install -g @miphamai/cli`（或重跑安装脚本），不要用 `mipham update`
  自举**。更彻底的做法（装进 staging prefix、校验通过后对包目录
  与 launcher 做两次同文件系统内的 `rename`，可扛 SIGKILL）记在 `ROADMAP.md` **D12**，本版未做。
  测试 3,065 → 3,079（257 → 258 文件）。

## [0.84.0] — 2026-09-22

### Added

- **权限分类器（`auto` 档）从设计到接线**：`core/permission-classifier.ts`（**fail-closed**，与既有
  `self-critique` 的 fail-open **刻意相反**）+ 接到全仓**仅有的两处**运行期闸门。安全契约是四步顺序：
  非 `ask` 判定原样返回 ⇒ 分类器只在允许清单内介入（否则成为绕开人写规则的万能通道）⇒
  无分类器 / 非 `auto` 则 fail-closed ⇒ 放行经 `allowRuleDecision()` 重新推导（永不强于一条
  allow 规则、组织级上限自动封顶）
- **分类器裁决台账** `core/permission-audit.ts`：`auto` 档的每一次裁决落
  `~/.mipham/permission-audit.jsonl`（append-only，目录 0700 / 文件 0600）。记录点选在裁决的
  **出生地** `resolveApproval()`（经 `ruled()` 收敛成唯一出口）而非两道闸门 —— 出生地**构造上**
  覆盖全部闸门。`verdict` 与 `level` **必须都记**：放行经 `allowRuleDecision()`，而组织级上限会把
  它压回 `ask`，只记一个会把「封顶」读成「放行」。**绝不记工具入参**
- **页脚字形按档取**：`PERMISSION_GLYPHS`（穷尽 `Record<PermissionMode, string>`，漏键即编译错）
  - `permissionGlyphPrefix()` —— `default` 档（默认、最常见）此前读到**它并不具备**的
    「自动接受」字形 `⏵⏵`
- **接线层测试**（此前 `test/ui/` 17 个文件**无一条**渲染 `InputBar`）：
  `test/ui/permission-cycle-wiring.test.ts` —— 按键那一跳（喂真终端发的 `\x1b[Z`，不是直接调
  handler）、转盘走完整圈（真 `PermissionSystem`，逐档复核页脚读数与引擎状态逐字相同）、
  四档语义各不相同（拿真 `check()` 逐档读数）；以及 `test/ui/input-history-wiring.test.ts`
- **对等守卫**：vendored 族**整族**（`test/integrity/shared-vendor-parity.test.ts`，按
  byte / comments-only / members 三档形状 —— 5 对里此前只有 1 对有人守）、两份 `types.ts` 的
  成员集合（`test/integrity/shared-types-parity.test.ts`）、根 README 的提供商与模型计数

### Changed

- `MODE_CYCLE` 末位由 `bypassPermissions` 改为 `auto` —— 前者仍**合法**、config /
  `MIPHAM_DAEMON_PERMISSION` / settings 可指名（「合法集 ⊇ 转盘」的结构不变，两张表**刻意不合并**）；
  `ALL_MODES` / `MODE_CYCLE` 同步拆开
- `~/.mipham` 收成单一真源：89 处字面量收敛到 `core/paths.ts` 的 `miphamHome(...segments)`
  （52 文件 / 62 调用点，必须**调用时**求值）；项目内沿用该文件已有的
  `join(<dir>, MIPHAM_DIR, …)` 惯用法，不造第三个 helper
- 遗留的 `'auto'` **级别**退役为 `'self'` —— 该级别全仓**零消费者** ⇒「行为不变」这一断言是**可测**的

### Fixed

- **输入历史每开一次模型选择器就清零**：`submittedHistory` 住在 `InputBar` 的**局部 state**，而
  `app.tsx` 有**三条路径把它整个卸载**（picker 三元两支组件类型不同 ⇒ 卸载而非复用、
  `apiKeyPrompt` 整棵早退、Ctrl+G）。历史改由 `app.tsx` 持有，两个浏览游标 ref 留在组件内
  （它们随卸载重置才是对的）
- **`config.yml` 的 `permission:` 真的认模式名**：旧实现只认 `bypass` 一个串，其余**静默落
  `default`** ⇒ 用户想**收窄**而闸门**反向移动**
- 两份 `types.ts`：契约补回漏掉的三个可选字段（对 `apps/web` 向后兼容），并修掉一处**假默认值**
  （契约写 `showThinking` 默认 `minimal`，而代码四处读数一致为 `off`）
- 设计文档 §五 Layer 2 的记录器名（原写全仓**零命中**的 `classifierCalls` ⇒ 照此 grep 会得出
  「Layer 2 未接线」这个**错误结论**，而四条断言都在）
- 根 `README.md` 的假主张清理（含提供商 / 模型计数）

### Removed

- `USER_CONFIG_DIR` —— 同一目录名的第三个名字；先复核**零消费者**（不是照着条目信），再两侧同删

## [0.83.0] — 2026-09-21

### Added

- **CRSI 账本按契约粒度落盘（B1）**：`appendEvalScore` 从「只落聚合分数」改为同时落每条契约的
  `{id, passed, role}`；新增 `getContractHistory` 与纯函数 `diffContractHistory`（五态
  `regressed` / `fixed` / `flaky` / `new` / `gone`），`/crsi eval` 只读展示契约级差异 ——
  此前账本只能回答「总分涨没涨」，回答不了「是哪条契约翻的」，而真回归与单次抖动在聚合层同形。
  旧记录没有 `results` 键（**缺席而非空数组**），读取侧跳过；新记录每条约 2–3 KB，
  `eval-scores.jsonl` 仍是 append-only、**当前无轮转**
- **CRSI 代价维（B2）**：`runTaskPerformance` 报告新增 `durationMs`，改进台账新增与分数数组
  **逐项对齐**的 `baselineDurations` / `postDurations`，两条渲染路径（`/crsi modify` 与
  `/crsi propose --prose`）经 `formatCostLine` 展示「均值 → 均值（×倍数）」一行。
  **只记录、不进任何闸门**：`verdict` / `deltaMean` / `noise` / `minEffect` 一律不看耗时字段

## [0.82.0] — 2026-09-20

### Added

- **CRSI ε 预登记**：`/crsi propose` 的候选须声明 `expectedEffect` 与 `risk`，改进台账新增
  `predictionHit` / `predictionHitRate`，`/crsi stats` 显示 ε 命中率与作废条款
- **CRSI 合并型收敛闸** `validateMergeConvergence`：`--crossover` 提案声明 `merge`，脚手架复杂度
  不得被合并型提案抬高；配套度量侧 `measureScaffold`（prompt 段数 / memory 条数 / 技能数）
- **anchor 契约两向守卫**（`test/integrity/anchor-contract-wiring.test.ts`）：`ANCHOR_CONTRACT_IDS`
  的声明与契约定义处的 `anchor: true` 标记两向比对，任一方向不相等都会失败

### Fixed

- VS Code 扩展公开文案两个计数与真源不一致：AI provider 数 `7` → `12`、工具数 `30` → `31`；
  并补上按「载体」枚举扫描面的工具总数守卫（原先只扫 `.md`，`package.json` 的 `description` 因此全绿）

## [0.81.9] — 2026-09-19

### Security

- **`Bash(...)` allow 规则可被复合命令绕过** —— 规则匹配对所有层级一律按「任一段命中」判，而 allow 是**授予**不是**过滤** ⇒ `Bash(git:*)` 一口授权 `git status && rm -rf ./src`，且不弹提示。改为按规则自身的 level 分向：deny/ask 留「任一段」（漏一段即洞，宽是对的），allow 改「每一段都要命中」；同时补上 `items.length > 0` 守卫 —— `[].every()` 为真，即「没有任何段可匹配」会满足任何一条 allow 规则，其本身即一处 fail-open
- **不可见 Unicode 的剥离集合不可审计** —— 集合写成 16 个**字面量**不可见字符：改不动也看不出来，而 tag 块（U+E0000–E007F）**每个邻族都已覆盖**却漏着（它自身不可见，可粘进命令里藏任意文本）。改写为 `\u{…}` 转义写法并补入该块与 6 个不可见填充符、边界由用例钉住（两端点都在集合内、紧邻的 U+E0080 不在）。变体选择符（U+FE00–FE0F）**刻意不收** —— emoji 承重，且这些参数会被**真正交给工具执行**，剥掉等于静默改写要写盘的内容

### Fixed

- **一个空块能让整个会话永久发不出去** —— `tool_result.content` 为空会被 API 判 400，而失败的是**整条请求（连同历史）** ⇒ 之后每一轮都重带上它、每一轮都失败。三条来路（工具成功但无输出 / 失败且无消息 / 日志投影缺字段）统一收口：空文本块滤掉、空 tool result 补 `(no output)` 占位、内容被滤空的消息**整条**不下发（空 content 数组同样被拒）
- **日志投影出来的 `content` 可能是 `undefined`** —— `JSON.stringify` 会把值为 `undefined` 的键**整个抹掉**，于是在投影里看不出来、到请求体上变成「这个 tool_result 没有 content」。分工钉死：投影负责形状，provider 负责出网合法，两边各有各的判据
- **`/bg` 报道「已启动」而 prompt 从未交给模型** —— 只建了 dashboard 一行，该行永停 `working`。接上后台代理注册表，成败都回写行状态（失败停在 working 与从未启动是同一种谎）
- **`/mcp disconnect` 报「已移除 N 个工具」而工具仍可调用** —— 连接持有的与注册表持有的不是同一个对象；改为真的从引擎注册表让出，计数取实际让出的数目
- **`--resume "<name>"` 是文档教给用户的假入口** —— 实现早就在，却零调用点，且该 flag 不在已知 flag 列表里（传了等于没传）。接通链路，并对未知会话名报错
- **`/resume last` 的文案说「历史已交给模型」，实际只渲染视图** —— 三处同一说法一并订正
- **worktree 会话里项目规则静默全失效** —— `.mipham/` 在 `.gitignore` 里，而工作树恰好建在 `.mipham/worktrees/` 下 ⇒ 真实检出里根本没有这个目录，规则 0 条、注入块 0 字符、无任何提示。cwd 落在 worktree 内时改为追加读项目根的规则；同名规则就近优先
- **`/upgrade` 在 registry 连不上时报「已是最新」** —— 「没问成」与「问过了、你就是最新」是同一个值。加 `checked` 位把两者分开：连不上时明说未做任何改动，不再印「✓ Already up to date」
- **三个状态文件「合法 JSON 但形状不对」让命令挂掉** —— `{}` / `null` / `"x"` / `123` 全是合法 JSON：一处非数组让每条插件命令一起挂，一处 `null` 在**启动路径**上抛，一处只查字段不查形状。三处一律收在**入口**：解析后先验形，形状不对按空表起步，不在各调用点补 try
- **同批状态文件的写是原地截断** —— 一次被打断的写不是「丢一条记录」：插件列表静默清空、用户批准过的每个目录静默退回未信任。改用原子写；判据取 **inode 变化**，不取文件权限、也不取「没留下 `.tmp` 残骸」（`mode: 0o600` 的裸写同时满足后两者）
- **workflow 的 `agent()` 把脚本算出的 prompt 以真实用户回合注入子代理** —— 无身份框定，脚本因此可借用户的权威。加脚本来源标记与框定
- **跨会话 `ask` 的「先问用户」写在正文里，而投递只发摘要** ⇒ 同意闸被写出来、却从未被施加；指示移进摘要

## [0.81.8] — 2026-09-18

### Added

- **基准适配器与两轮结果落库（开发工具，不进 CLI 产物）** —— `benchmarks/` 下新增 Harbor 适配器（手写 RFC6455 客户端 / daemon REST 客户端 / 七步 driver / 作业级 token 台账 / 复现脚本），两轮结果（`terminal-bench@2.0` 10 题、`swebench-verified@1.0` 10 题）与各自的可重跑脚本一并入库。**这两个数是仪器验通的读数、不是成绩** —— 题量 11% / 2%、未固定 seed、`k=1`、跑在 x86 模拟下；完整口径、选题规则与已知限制见 `benchmarks/README.md`

### Security

- **`Bash(...)` deny 规则可被「基命令前的 shell 噪声」绕过** —— `( rm -rf x )`、`{ rm -rf x; }`、`! rm -rf x`、`FOO=bar rm -rf x`、`IFS=x rm -rf x`、`for f in *; do rm -rf x; done` 都让规则匹配器看不到真正的基命令（同一条噪声也让 `Read(secret)` 漏判）。根因是命令解析有**四条各自 tokenize 的路径**，而「剥掉前导噪声」这条知识只被其中一条知道一半；修法不是给四处各打一个补丁，而是抽成**一个**导出函数、两条匹配路径都经过它 —— 只接一条等于只修一半。同批修掉四类同族绕过：`timeout --preserve-status cat secret` 的 `cat` 不再被当成 duration 吃掉；进程替换 `<(…)` / `>(…)` 里的命令递归解析；`~` 与 `$HOME` 展开（`cat ~/.ssh/id_rsa` 不再绕过绝对路径规则）；worktree 逃逸守卫改用路径解析（原实现拼接式解析不归一 `..`、只看第一个 `cd`、用字符串前缀判归属）
- **从 npm 装插件不再执行被装包的安装脚本** —— `execSync('npm install … --no-save')` 缺 `--ignore-scripts`，任意 npm 包的 `postinstall` 因而以用户全权运行；改为 `--ignore-scripts` + `execFileSync` argv 数组

### Fixed

- **Artifact 工具回报的 URL 必然 404** —— 工具写 `<cwd>/artifacts`、服务端根在 `<cwd>/.mipham/artifacts`，两个目录不同源；收进单一解析函数，`/artifact open` 与 `/artifact list` 不再写死会话 id
- **两套并行版本机制删掉一套** —— 被删那套的唯一写者自落地起**零调用点**（它维护的 `current.html` 从未存在过），`/artifact` 按名字订阅改为读工具真正写下的那份文件、找不到即 404（此前挂着一条永不产出内容的 200 空流）。删除当场暴露 `stop()` 只调 `server.close()` —— 它只停止**接收新连接**，已建立的 socket 仍在被服务 ⇒「已停止」的服务器还在旧端口应答
- **manifest 的读与写分家** —— 去重只按 `name`（而 manifest 是全局一份、条目自带 `sessionId`）⇒ 两个会话的同名 artifact 互相顶掉；读失败静默当空、而写路径紧接着整份重写 ⇒ 一份坏索引被覆盖成「只有这一条」。改为按 `name`+`sessionId` 去重、坏索引改名隔离（字节保留）、索引原子写
- **`Read` 声称支持 offset/limit 却先整读再切片** —— 超限一律报错，而错误里建议的「use offset/limit」对它要救的那类文件根本不可执行；改为直接从 fd 取窗口、文件大小闸换成扫描预算（20 MB 文件的 2000 行窗口：旧路径 RSS +141.5 MB，新路径 ~0）
- **定时任务没有归属目录** —— 存储是全局单店、`ctx` 被丢弃 ⇒ 任何目录建的任务被任何其他目录的会话执行，且 id 只由 `cron+prompt` 决定、跨项目碰撞。加 `cwd`/`sessionId` 并按 `cwd` 过滤；更早写的无 `cwd` 任务**照发不误**（不静默停掉用户已建的日程），列表把它们标 `[无归属]` 并给出处置办法
- **`atomicWriteFileSync` 的固定 `.tmp` 名在并发写者之间互撞** —— A 的 rename 把 B 的内容搬到位、B 再抛 ENOENT ⇒ 丢写；改为 pid + 随机后缀、异常路径清孤儿
- **`/resume` 的健壮性** —— `SessionLog.open()` 是磁盘→内存的唯一入口，却只 `JSON.parse` 不校验，而**合法 JSON 不等于合法事件**（`compaction/rewrite` 少 `messages` ⇒ 投影时 `out` 变 `undefined` 即抛）；`SessionStore.list()` 的 `try` 又包住整个 `for` ⇒ 一个坏文件让 `/resume` **一个会话都不显示**。改为入口逐条校验（只校验投影真有分支的变体、未知 `type` 放行）+ 列表逐文件兜底
- **三个状态文件非原子写** —— `preferences.json` / `keys.json` / `config.yml` 都是裸 `writeFileSync` **原地截断**，而三个读侧都把「读不出来」吞成空 ⇒ 丢的是**整份**；`keys.json` 还是「转了一半」（写固定名 `.tmp` 却不 rename，留下一份废物、目标仍非原子）。改原子写并统一 `0o600`
- **搜索工具的两处错判** —— `grep` 的输出上限只接 find 回退一条路径（rg 快路径原样返回，46 万字符照发）；find 回退把「出错」读成「无匹配」（BSD `find` 在正则非法 / 目录不可读 / grep 不存在这三种情形下退出码都是 1）；`runSearch` 的 stderr 从不消费 ⇒ Node 下 stderr 超阈值即卡满 120 s 超时兜底
- **CLI 输出被静默截断** —— 声明了上限却没有施加点，截断与正常结束不可分

## [0.81.7] — 2026-09-17

### Added

- **遥测与崩溃上报（CLI 侧）** —— 新增 `apps/cli/src/telemetry/`（门面 / 开关 / 队列 / 白名单 / 发送 / 脱敏 / 崩溃）。**默认关闭**：三级 fail-closed（`MIPHAM_TELEMETRY=off` 硬关 > 用户 opt-in > 项目**只能否决不能授予** —— 否则 clone 一个仓库就等于被它代授同意），故意不提供授予同意的环境变量，同意必须是持久、刻意的动作；开关落 `settings.json` 而**非** `config.yml`（后者是首装向导的存在性判据，写它 = 向导从此不再出现，且其浅合并会打掉兄弟表默认值）。**零出网**：遥测默认关闭，未开启时不发任何请求。采集与发送**解耦** —— `process.on('exit')` 不能 await ⇒ 退出时同步落本地队列（0600，上限 100 条），下次启动异步发送，失败静默留队。崩溃上报**无条件安装**（关闭遥测时也装 —— 它是防挂起的那一环），记录后必须 exit，否则崩溃变静默挂起；栈**脱敏截断**（`cwd` → `<cwd>`、`home` → `~`、home 下第一段 → `<dir>`），只发消息 sha256 前 16 位，不发正文
- **遥测端点解析收进单一真源，默认指向官方接收端** —— `env > 用户 settings > 官方接收端`，默认值即 `https://log.onemipham.com/v1/events`；`/telemetry status` 加一列解析来源，首跑提示写明数据发往哪里。`'none'` 哨兵是**唯一**能表达「开着、但哪儿都不发」的写法 —— 解析式 `env || user || default` 下空串是假值，用户写 `''` 会一路下沉到官方默认值，等于想静默却被接上了线。**零网络保证的施加点随之搬家**：从前是「端点默认为空」物理上打不出去，现在站在「关闭」与「一次生产请求」之间的只剩 `initTelemetry` 的 `if (consent.enabled)` 这一道判断
- **遥测接收端** —— 新增 `apps/telemetry/`，本仓库的对外服务：公开、**只写**、**无读端点**（读取路径只做离线 `report` 命令 —— 读取的暴露面远大于写入，且没有可继承的鉴权）。只存**维度聚合**：分区键是服务端接收日（UTC），客户端 `occurredAt` 只进偏移桶（未校验的时间戳是无界维度），原始 label 一个字节都不落盘，`installId` 只喂 HLL 不落盘。部署资产（vhost / systemd unit / 装 Node / 部署脚本 / 本机 TLS 验证器）同批落地

### Changed

- **崩溃事件的线上契约升到 `schemaVersion: 2`，`stackFrames` 不再上传** —— 断的是**客户端 ↔ 接收端之间的线协议**，不是 CLI 用户可见的接口。接收端从来不存帧（「只存维度聚合」下，一串栈帧没有地方可放 —— 只被计数后就地丢弃），既然发了必然丢掉，客户端继续发就只换来每次崩溃约 3 KB 上行与一个额外的隐私面。`frameCount` 保留 —— 它才是「栈短」与「栈被截」的区分依据；帧**仍脱敏、仍只留本进程内存**，供本地诊断（脱敏是这条记录的保证，不该取决于哪个消费者来读它）。接收端的 v1 汇聚路径**长期保留**，已发布的 v1 二进制收不回来，两个版本都是真实流量。代价已认下：**崩溃通道不再能告诉你崩在哪一行**

### Fixed

- **`mipham daemon start` 在编译产物里起不来** —— 自启命令假设了源码模式的 argv（`spawn('bun', ['run', <path>])`），而在产物里这条路双错：`bun` 不在 PATH（产物存在的全部理由就是用户不必装 Bun），且入口是 `$bunfs` 虚拟路径、新起的解释器读不到。改为 re-exec 自身（`process.execPath`）。同批修掉 argv 判别式：产物实测 argv 为 `["bun","/$bunfs/root/mipham",…]`，`$bunfs` 入口没有扩展名，旧判据据此把它当成第一个用户参数，`__daemon` 分支在产物里因此不可达（源码模式恰好判对，故单测全绿）。判别式改为只问一件事 —— 解释器是否在 `argv[0]`
- **daemon 起不来时谎报成功** —— `daemon start` 现在轮询就绪，spawn 失败、早退、超时三条路径一律走非零退出码 + stderr，不再打印假的 `Daemon started`；`daemon restart` 同批修掉「把旧 pid 当新结果」—— 旧实现发 `SIGTERM` 后固定等 500 ms 就启新进程，而后者开篇探测的 pid 文件尚未被旧进程 unlink，于是打印 `Daemon restarted (PID: <旧>)` 并正常退出，实际一个都没起来。改为轮询到旧 daemon 真退，等不到即拒绝

## [0.81.6] — 2026-09-15

### Security

- **`Read(...)` deny 规则可被「读文件写 stdout」的命令绕过** —— `READER_COMMANDS` 缺了整类读者命令：`fmt secret` / `column -t secret` 同样把文件送进了工具的读路径，检查器却认不出这条命令是读者。补 20 条 —— 文本格式化/变换 `fmt column pr fold expand unexpand rev look bat`，结构化读者与字节工具 `jq yq base64 md5sum sha1sum sha256sum shasum cksum sum cmp iconv`。均只入读列表、不入写列表（`md5sum secret` 不该被 `Edit(...)` 规则拦下）。命令名单是唯一缺口：扫描器对每个非 `-` 开头的参数都入读列表（选项值也当路径，只多不少），文件跟在哪个选项后面不影响命中
- **`/clear` 与 `/resume` 未清空文件读取追踪** —— `engine.readFiles` 是会话级「读过才能覆盖」的凭据（`write` 工具 fail-closed 依据它拦下覆盖未读文件），却只在**同一段对话**内成立：`/clear` 清空历史、`/resume` 载入另一段历史，两者都不碰它 → 新对话可以覆盖它从没读过的文件。新增 `QueryEngine.resetFileTracking()`，在「消息历史被替换」的两条路径上调用。清空是 fail-closed 方向 —— 未读文件宁可要求重读，不可静默覆盖

### Fixed

- **MCP `tools/list_changed` 通知紧循环放大** —— 此前是「一条通知 → 一次 `tools/list` round trip → 一次下游全量重注册」，服务器按工具逐条通知（或陷入循环）时这个 1:1 就是放大器：持续高 CPU + 重注册风暴。改为每连接合并刷新：250ms 去抖窗口 + **2000ms 上限**（纯 trailing 去抖会被「永不停止通知」的服务器无限推后），in-flight 期间到达的通知排队补跑一次、不丢变更；`disconnect` / `closeAll` / `reconnect` 三处清定时器（`reconnect` 必需 —— 同名重连会让遗留定时器打到新连接上），定时器 `unref()` 不吊住 CLI 进程退出

## [0.81.5] — 2026-09-14

> 0.81.4 未作产品版本发布 —— 该号已被 VS Code 扩展的 changelog-only 重发占用（仍跑 CLI 0.81.3），产品线故跳至 0.81.5。

### Security

- **daemon 外部 API 此前可被任意网页驱动** —— 两道「安全」机制实际都只防「响应被读到」，不防「请求被发出」：`auth.ts` 用 socket IP 判 loopback 即免鉴权，而浏览器发出的请求源 IP 同样是 `127.0.0.1`（Chrome 视 `http://127.0.0.1` 为可信来源，HTTPS 页面也不触发混合内容拦截）；`cors.ts` 只在响应上加 ACAO 头，而 `mode: 'no-cors'` 强制 `text/plain`（属 CORS 安全列表内，**不触发预检**），`await req.json()` 也不看 Content-Type → 请求照发、handler 照跑。WebSocket 握手更根本不受同源策略约束：浏览器会带 `Origin` 但不会拦连接，服务端不校验即等于全开。完整攻击链：恶意网页 → WS 或 `POST /api/v1/sessions` 带任意 `cwd`（此前零校验）→ 驱动 agent 读取该目录下任意文件（`read` 为 `auto` 级，`BLOCKED_PATHS` 不含主目录）→ 结果经 WS 流回页面；`createSchedule` 还会持久化并在重启后仍存活。RCE 仅被 `write` / `edit` / `bash` 的 `ask` 挡住，而 daemon 中 `ask` 等于拒绝。修复：新增 `originMiddleware` —— 无 `Origin`（CLI / curl）放行以保持既有行为不变，有 `Origin` 且不在 `MIPHAM_CORS_ORIGINS` 白名单则 403，置于 WS upgrade 之前故握手一并覆盖（刻意不复用 `isLocalhostOrigin`，其子串匹配会让 `https://localhost.evil.example` 通过）；`POST /api/v1/sessions` 的 `cwd` 须为已信任 workspace 或 daemon 启动目录子树内。已验证 Bun 与 Node/undici 的 WS 客户端均不发 `Origin`，CLI 行为不变

### Changed

- 内置 `superpower` skill 2.0.0 → 2.1.0：选择性吸收上游 `obra/superpowers` 增量 —— `<SUBAGENT-STOP>` 守卫（子代理拿到具体任务时忽略此技能）、announce 约定（`Using [skill] to [purpose]`）、Red Flags 表 5 → 12 行
- 修正该 skill 中引用了 Mipham 并不存在的技能名（`brainstorming` / `systematic-debugging` / `frontend-design` / `mcp-builder` → `to-spec` / `debug-loop` / `implement` / `codebase-design`），并补全 `User Instructions` 的优先级链（用户指令 > 技能 > 默认行为）。明确**不**引入上游 `Platform Adaptation` —— 那是 Codex / Pi / Antigravity / Hermes 各家 harness 的分支指引，对本项目自己的 harness 无意义

## [0.81.3] — 2026-09-14

### Fixed

- `.mipham/rules/*.md` 路径作用域规则此前**从不注入** —— `RulesLoader` 自引入起就未接线（生产零调用点、模块从不加载；knip 未报，系覆盖率实测发现）。现已接线：启动时加载规则，并在**两处**工具执行后注入 —— 首轮工具与多轮工具循环。后者原先完全未接，只补前者会让规则迟一整轮用户输入才生效

## [0.81.2] — 2026-09-14

### Added

- knip 未接线检测（报告制）—— `pnpm knip` 列出生产零调用的模块；带 `--no-exit-code`，不进 CI 闸门

### Fixed

- 首装向导不再写裸 `models:` 行，保住内置模型的元数据
- `doctor` 的 CLAUDE.md 审计跳过已披露章节，防 `prompt-exclude` 剥掉正文指针
- `deploy status` 子命令不再重复打印状态

### Changed

- 移除失效的静态页部署链 `deploy-cn.sh`
- CLAUDE.md 事实校正：`vajra/compose` 通路未接 live startup、测试数 2259→2266、Vitest 5、测试分项表按 `test/` 各目录实测重算
- 变更记录表拆分到 `docs/claude-md-history.md`

## [0.81.1] — 2026-09-13

### Fixed

- session 持久层的家目录解析统一走 `os.homedir()` —— 原先依赖 `process.env.HOME`，HOME 分裂时会话日志写到错误位置

### Changed

- 全量统一家目录解析：`apps/cli/src` 对 `process.env.HOME` 的直接引用归零

## [0.81.0] — 2026-09-12

### Added

- `workflow` 的 `parallel()` 并发上限可配置：`MIPHAM_WORKFLOW_MAX_CONCURRENT_AGENTS`（1–256，默认按 CPU 取 16）

### Fixed

- 安全：前缀命令（`sudo` / `env` / `timeout` / `nohup` / `command` / `eval` / `nice` / `xargs` / `doas` / `exec` / `stdbuf`）不再绕过 Read / Edit / Bash 的 deny 规则 —— 新增 `PREFIX_COMMANDS` + `effectiveCommand()` 剥离包装命令定位真命令
- Web：React 18→19 统一，修 `build-web` 与 typecheck 失败

### Changed

- 依赖升级：vitest 4→5、eslint、@typescript-eslint、@types/bun、actions/setup-java
- Dependabot PR 在 CI 绿后自动 squash 合并（npm 生态）

## [0.80.1] — 2026-09-12

### Fixed

- 欢迎屏 banner 间歇重复：MCP 注册 / 连接消息改走 `console`，不再用 `process.stderr.write` 直写 stderr 绕过 Ink 的 `patchConsole` 光标追踪

## [0.80.0] — 2026-09-12

### Changed

- 升级 Ink 5.2.1 → 7.1.1、React 18 → 19

### Fixed

- 欢迎屏 banner 间歇重复（升级尝试，未根治；真根因见 0.80.1）

## [0.79.1] — 2026-09-11

### Fixed

- Backspace 键回归修复 —— Ink 把 macOS Backspace（`\x7f`）映射成 `key.delete` 而非 `backspace`
- 上下键历史导航抽为纯函数

## [0.79.0] — 2026-09-11

### Added

- 输入光标左右移动 —— `applyEdit` 纯函数 + `MiphamTextInput` 光标跟踪

### Fixed

- 底部状态行行距统一；`graft` / `ctx` 状态行去掉 dim 字体
- 欢迎屏 `/help` 重复
- release 管线：npm 11 安装改用 sudo；JetBrains 重复版本幂等跳过

### Changed

- npm 发布切换为 OIDC trusted publishing

## [0.78.0] — 2026-09-11

### Added

- skill `trim-process-prose` —— 压缩冗余的过程叙述

### Changed

- skill 重命名 `systematic-debugging` → `debug-loop`（frontmatter 的 `name:` 才是真名，文件名仅作回退）

### Removed

- skill `pre-push-checks`

## [0.77.2] — 2026-09-10

### Added

- Bash 工具 description 指引：用大白话描述命令，不回显命令本身

### Fixed

- 安全：marketplace 路径净化 —— 未净化的 skill 名拼进文件路径可致 path traversal

## [0.77.1] — 2026-09-09

### Security

- 修 audit 高危依赖：next 15.5.25（2 个 critical RCE）、sharp 0.35.4、js-yaml 4.3.2

## [0.77.0] — 2026-09-09

### Security

- 不可信内容规则：读取外部产出（artifact / MCP / web）时当数据处理、不当指令 —— 双层固化（`instructions.ts` always-on 规则 + self-critique 审计准则）

## [0.76.0] — 2026-09-07

### Added

- 新增 Provider：MiniMax（国内 / 国际两区域，API key 按区域发放）、GPT-6 Astra、Claude Mythos 5（受限模型）
- `skills.reminder` 启动 token 开关：full / compact / off

### Fixed

- 安全：Bash 规则递归替换 `$()` / 反引号 —— 堵 zsh 赋值隐藏替换绕过 deny 规则

## [0.75.0] — 2026-09-05

### Added

- `/skill-doctor` —— 列出未使用 skill 及其 context 成本，按证据 prune
- 状态栏 PR 指示器 —— 分支名旁显示 PR #N（按状态着色）

## [0.74.0] — 2026-09-04

### Added

- CRSI eval harness 增加 self-report-diagnostic 锚点（评分路径不含 LLM）

### Fixed

- 粘贴乱序 / 丢内容 / 冻住：换掉 `ink-text-input`（分块投递时读渲染闭包旧值切片插入）→ `MiphamTextInput` ref 原子追加 + 归一化 `[\r\n\t]+` + 移除节流

## [0.73.1] — 2026-09-04

### Fixed

- Grep 顶层范围 fail-fast：`rg` exit 2 不再被误判为「未安装」而回退慢 `find`（曾致硬扫家目录、15 分钟卡死）
- 会话退出兜底按真名落盘，并补 `SIGHUP` 处理

### Changed

- banner 副标题更新为「超级智能体」

## [0.73.0] — 2026-09-04

### Added

- 权限规则结构校验：畸形规则不再静默失效，并输出 stderr 告警

### Fixed

- Read→Bash 保守范围回归（避开上游 CC 259→260 的误拦回退）
- `sync` 脚本写双副本；om-v5 模型重同步

### Changed

- 首屏不再显示 contextWindow 原始数字，`/models` 改用友好单位

## [0.72.0] — 2026-09-02

### Added

- WebFetch / WebSearch 失败时提示改走 `web-access`(CDP)

### Fixed

- 安全：Bash deny 规则边界扩展 + 复合命令分段（堵 `cat` 绕过 Read deny）

## [0.71.0] — 2026-09-01

### Added

- `/memory dedup` —— 只读的近重复记忆报告
- `/cost` 增加 prompt-cache 行；`/mcp connect` 输出 HTTP 信息披露
- managed rule 禁用护栏：拒绝「禁用某能力」的 blanket 规则
- CRSI 原子激活：台账原子写 + pending verdict 持久化 manifest

### Fixed

- 安全：git 危险守卫移除对 `gh` 的误拦（不再因命令中含 git 描述文本而拦截 gh）
- Provider：畸形 `tool_use` 丢弃空 name；`[DONE]` 路径补 id 兜底

## [0.70.0] — 2026-08-31

### Added

- marketplace 源机制 —— 任意公开仓库的 skill 可安装；社区 registry 增加 `grill-me` / `eli5`
- hooks 全链路对齐 Claude Code：stdin / stdout JSON 协议 + `settings.json` 接线
- `/fix` —— 确定性自修复命令；`/fix test` —— LLM 修复失败测试（复用 bench 冻结判定）

### Changed

- `/loop init` 删去 `.sh` 约定；`/hooks` 改为指向 `settings.json`

## [0.69.0] — 2026-08-31

### Added

- CRSI Recuris 记忆进化四组件 + 记忆卫生
- CRSI 工作记忆 Phase 2：证据接地状态机
- CRSI 工作记忆接线 TaskList —— 任务完成证据门（软门）

## [0.68.0] — 2026-08-30

### Added

- 补全 init 规范文件（CHANGELOG / DEVELOPMENT / TRADEMARKS / .github/CODEOWNERS）
- 本 CHANGELOG 自此版本起开始维护
