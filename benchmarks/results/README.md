Files kept here are the committed record. The phase archives (written by
`../run-benchmark.sh`) are redacted on the way in; `integration-gate.json`
(written by Task 12) must also go through `benchmarks.redact`; `ledger.json` is
runtime state and is gitignored. The verbatim container output stays in
`../jobs/`, which is gitignored.

---

## Phase 1 · Terminal-Bench 逐条核对（T13 Step 3）

> 本节是 **T13 Step 3 点名的五件事的逐条核对记录**。面向公众的五条强制披露
> （spec §4.1）在 `../README.md`（Task 14 创建）—— 本节不复制它们。
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

**10 题里只有 8 题产出了 trial。** 另两题在 harbor 层就没有结果文件
（`jobs/phase1/phase1/<trial>/agent/mipham-result.json` 不存在）：`bn-fit-modify`
与 `break-filter-js-from-html`，对应 harbor 记的 `NetworkConnectionError` ×1 与
`EnvironmentStartTimeoutError` ×1。**故上表 `totals` 是 8 题的合计，不是 10 题的**
—— 不可与全量 10 题的成绩比对。`completedTasks: 4` 只数 `status == "done"`。

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
写下的两个输入价（$0.022 命中 / $0.66 未命中，每 1M）与峰值 output $3.96 / 1M：

|                    | 算法                   | 美元 |
| ------------------ | ---------------------- | ---: |
| output（两端相同） | 131,512 × 3.96 / 1M    | 0.52 |
| input · 全部未命中 | 7,842,050 × 0.66 / 1M  | 5.18 |
| input · 全部命中   | 7,842,050 × 0.022 / 1M | 0.17 |

⇒ **$0.69 – $5.70**，相对「≤ $200 整轮」是 **0.35% – 2.85%**。
区间**整个宽度**都来自 cache 命中拆分这一项未知数。
即便输入未命中价实际高 10 倍，上端也只到 ~$52，仍在 $200 之内。

---

## 与集成门不同的事实（Step 3 允许改 `integration-gate.json` 的那一条）

**核对结果：无，故 `integration-gate.json` 本次未改。** 门里记的那笔是
`circuit-fibsqrt__YbEPBT4`（output 8607，`usage` 与 `sessionCounters` 一致）；
本轮同题是**另一次采样** `circuit-fibsqrt__RWekihS`（output 8565）。两次是**不同 trial**，
不构成对门的否证 —— 本轮**未固定采样 seed**（见 Task 14 的披露 ④）。
门的 `hostArch: arm64` / `dockerPlatform: linux/arm64` 与本轮 8 题逐字相同。

---

## 本轮一并记下的两条事实（如实记，不替它辩护）

**一、跑的那个二进制里，没有截断这个仪器。** 8 题的 `binaryVersion` 都是
`@miphamai/cli v0.81.7`、`binarySha256` 都是 `a0fa72aa…d670`；而截断修复
`4a7724b` 与 `b3dd310` **不是 `v0.81.7` 的祖先** —— 实测
`git merge-base --is-ancestor 4a7724b v0.81.7` 退出码非零（`v0.81.7` = `665ca9a`）。
⇒ 本轮**结构上不可能**出现 `output_limit` 标记。这**不是**「没有发生截断」的证据，
而是「那个标记不在这个二进制里」。**R61 那条判据因此仍未回答，且无法由本轮回答。**

**二、一个未解释的整数边界。** `adaptive-rejection-sampler` 的 `outputTokens`
**恰好是 8192**（2 的幂），`stopReason` 却是 `end_turn`，且该题
`toolResults.total: 0`、`turns: 1` —— **一次工具调用都没有发生**。
8192 是 `apps/cli/src/providers/openai-compat.ts:29` 的兜底常量，但同轮另有三题
output 超过 8192（8,879 / 8,565 / 11,326）⇒ 至少那三题的请求上限高于 8192。
**机制未查明：只登记读数，不给归因。**

**官方分数（harbor 报的，不是我们算的）**：`Mean: 0.000`，8 题 reward **全为 0.0**。
