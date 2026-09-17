Files kept here are the committed record. The phase archives (written by
`../run-benchmark.sh`) are redacted on the way in; `integration-gate.json`
(written by Task 12) must also go through `benchmarks.redact`; `ledger.json` is
runtime state and is gitignored. The verbatim container output stays in
`../jobs/`, which is gitignored.

---

## Phase 1 · Terminal-Bench 逐条核对（T13 Step 3）

> 本节是 **T13 Step 3 点名的五件事的逐条核对记录**。面向公众的五条强制披露
> （spec §4.1）稍后落在 `benchmarks/README.md` —— 本节不复制它们。
>
> 数据源：`phase1-terminal-bench.json` 的 `totals` 与 `trials[].result`。
> `usage` 来自 adapter 对 WS 流的累加（**协议事实**）；`sessionCounters` 来自
> daemon 自己持久化的计数。

### ① 每题的 `status` 与 token 数

| 题                           | `status`            |         input |      output |          合计 |
| ---------------------------- | ------------------- | ------------: | ----------: | ------------: |
| `adaptive-rejection-sampler` | `done`              |         6,817 |       8,192 |        15,009 |
| `cancel-async-tasks`         | `done`              |       178,296 |      11,326 |       189,622 |
| `caffe-cifar-10`             | `done`              |        28,649 |       8,879 |        37,528 |
| `circuit-fibsqrt`            | `done`              |        16,228 |       8,565 |        24,793 |
| `chess-best-move`            | `deadline_exceeded` |     1,955,973 |      48,332 |     2,004,305 |
| `build-cython-ext`           | `deadline_exceeded` |     3,331,064 |      22,169 |     3,353,233 |
| `build-pmars`                | `deadline_exceeded` |     1,733,285 |      16,075 |     1,749,360 |
| `build-pov-ray`              | `deadline_exceeded` |       591,738 |       7,974 |       599,712 |
| **合计（8 题）**             |                     | **7,842,050** | **131,512** | **7,973,562** |

**harbor 建了 10 个 trial，10 个 trial 目录也都在；其中 8 个跑到了 agent 结果，
另 2 个没有结果文件**（`jobs/phase1/phase1/<trial>/agent/mipham-result.json` 不存在）：
`bn-fit-modify`（`EnvironmentStartTimeoutError`）与 `break-filter-js-from-html`
（`NetworkConnectionError`）—— 这两个错误类型是**逐题读各自的 `result.json`** 得来的，
**不是按题目顺序推的**（按位置读会读反）。**故上表 `totals` 是 8 题的合计，
不是 10 题的** —— 不可与全量 10 题的成绩比对。`completedTasks: 4` 只数 `status == "done"`。

### ② 触发上限的题数

`budgetExceededTasks` = **0**。没有任何一题的 `status` 是 `budget_exceeded`
（脚本判据 `run-benchmark.sh:160`），上限**一次都没有咬住** ⇒
「中止发生在第几题之后」这一问本轮不适用。

### ③ `usage` 与 `sessionCounters` 是否一致

**不一致，4 题，逐题列出：**

| 题                 | `usage`（协议累加）       | `sessionCounters`（daemon 落盘）       |
| ------------------ | ------------------------- | -------------------------------------- |
| `chess-best-move`  | in 1,955,973 / out 48,332 | in **0** / out **0**（`turnCount: 0`） |
| `build-cython-ext` | in 3,331,064 / out 22,169 | in **0** / out **0**（`turnCount: 0`） |
| `build-pmars`      | in 1,733,285 / out 16,075 | in **0** / out **0**（`turnCount: 0`） |
| `build-pov-ray`    | in 591,738 / out 7,974    | in **0** / out **0**（`turnCount: 0`） |

**规律（读数，非推测）**：不一致的 4 题**恰好就是**那 4 题 `deadline_exceeded`，
一致的 4 题**恰好就是**那 4 题 `done`，无一例外。不一致的方向上
`sessionCounters` **总是少报的那一侧**，且这 4 题的 `updatedAt == createdAt`
—— 即会话记录停在创建的那一刻，之后再没被写过。

**归因（是假设，不是读数）**：`apps/cli/src/daemon/session-worker.ts:198` 的
`incrementTurn(...)` 在引擎 `for await` 循环**退出之后**才执行，而 deadline 杀进程
发生在循环中间，那一笔就永远没落盘；`usage` 则由 adapter 从 WS 流累加，不经过 daemon
那次写。**若这个归因错**，受影响的是 Task 15 该拿哪一列当第二轮上限的依据 ——
本轮不据此改任何代码。

### ④ 总 token 与上限的比值

**7,973,562 / 50,505,050 = 15.79%**。

口径一致性的旁证：`ledger.entries` 求和 = 7,999,255，减去**开跑前**集成门那一笔
25,693 = 7,973,562，与 `totals.tokens` 逐字相等。

### ⑤ 总成本（区间，不是精确值）

`usage` 只给 `inputTokens` / `outputTokens` 两个总数，**没有 cache 命中拆分**，
而命中价是未命中的 1/30 ⇒ 账单与 token 数无法一一对上，只能给区间。按 spec §六
写下的**谷段**两个输入价（$0.022 命中 / $0.66 未命中，每 1M）与**峰段** output
$3.96 / 1M：

|                    | 算法                   | 美元 |
| ------------------ | ---------------------- | ---: |
| output（两端相同） | 131,512 × 3.96 / 1M    | 0.52 |
| input · 全部未命中 | 7,842,050 × 0.66 / 1M  | 5.18 |
| input · 全部命中   | 7,842,050 × 0.022 / 1M | 0.17 |

⇒ **$0.69 – $5.70**（**两个端点都以谷段输入价计价**），相对「≤ $200 整轮」是
**0.35% – 2.85%**。

区间里有**两个**未知数，不是一个：

1. **cache 命中拆分** —— `usage` 只给两个总数、不给拆分。这一项决定端点是 $0.69 还是 $5.70。
2. **本轮落在哪个计价窗口** —— 输入价那对是**谷段**价，而 output 按**峰段**计价。
   **峰段输入价没有被记录**：本仓**已跟踪**的文件里查不到峰/谷时段的定义
   —— 用 `16:30` / `00:30` / `08:30` / `北京时间` 这四个词去查，**每一处命中都出自本段自身**。
   下载数据集后 `benchmarks/.datasets/` 下会出现同形数字，那些是任务夹具的
   **时间戳/时刻标注**，不是计价时段定义。
   若这一跑落在峰段，输入更贵，**真实账单可能高于 $5.70**，且**两个端点会一起上移**。

**所以上表是「谷段计价下的区间」，不是「成本的上界」**，也不是「成本一定落在其中」。
$200 那条比对的余量极大（即便输入价高 10 倍，上端也只到 ~$52），故这层不确定性
不影响「远低于上限」这个结论 —— 但**不能**由这三点推成「$5.70 就是上限」。

---

## 与集成门不同的事实（Step 3 允许改 `integration-gate.json` 的那一条）

**核对结果：无，故 `integration-gate.json` 本次未改。** 门里记的那笔是
`circuit-fibsqrt__YbEPBT4`（output 8607，`usage` 与 `sessionCounters` 一致）；
本轮同题是**另一次采样** `circuit-fibsqrt__RWekihS`（output 8565）。两次是**不同 trial**，
不构成对门的否证 —— 本轮**未固定采样 seed**（Harbor 与 provider 均未固定），
因此逐题输出不可逐字重放，可复现的是流程与判据。
**门的 `hostArch` / `dockerPlatform` 无法与本轮比对** —— `phase1-terminal-bench.json`
**根本不记录这两个字段**（其全部键路径里都没有），adapter 也没写。
「同一台主机、同一天」是**推断，不是读数**；门的这两个值因此是**唯一有记录的那一份**，
本轮结果文件里没有可与它对照的副本。

另需注意：门的 `dockerPlatform` 记的值**本身就另有存疑** —— 它取自
`docker version --format '{{.Server.Os}}/{{.Server.Arch}}'`，**记录的是 docker _server_
的平台，不是 trial 容器的平台**。故**不要把它当作本轮的运行平台读**。

---

## 本轮一并记下的两条事实（如实记，不替它辩护）

**一、跑的那个二进制里，没有截断这个仪器。** 8 题的 `binaryVersion` 都是
`@miphamai/cli v0.81.7`、`binarySha256` 都是 `a0fa72aa…d670`；而截断修复
`4a7724b` 与 `b3dd310` **不是 `v0.81.7` 的祖先** —— 实测
`git merge-base --is-ancestor 4a7724b v0.81.7` 退出码非零（`v0.81.7` = `665ca9a`）。
⇒ 本轮**结构上不可能**出现 `output_limit` 标记。这**不是**「没有发生截断」的证据，
而是「那个标记不在这个二进制里」。**「截断会发生、且标记应出现」这条判据因此仍未回答，
且无法由本轮回答。**

**二、一个未解释的整数边界。** `adaptive-rejection-sampler` 的 `outputTokens`
**恰好是 8192**（2 的幂），`stopReason` 却是 `end_turn`，且该题
`toolResults.total: 0`、`turns: 1` —— **一次工具调用都没有发生**。
8192 是 `apps/cli/src/providers/openai-compat.ts:29` 的兜底常量，但同轮另有三题
output 超过 8192（8,879 / 8,565 / 11,326）⇒ 至少那三题的请求上限高于 8192。
**机制未查明：只登记读数，不给归因。**

**官方分数（harbor 报的，不是我们算的）**：`Mean: 0.000`，8 题 reward **全为 0.0**。
