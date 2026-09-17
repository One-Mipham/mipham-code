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

---

## Phase 2 · SWE-bench Verified 逐条核对（T18）

> 与上一节同构：面向公众的披露落在 `../README.md` 的 Phase 2 一节，本节是**内部核对记录**。
>
> 数据源：`phase2-swebench-verified.json` 的 `totals` 与 `trials[].result`；**分数不在那份 JSON 里**
> （单题 `result` 的键与 Phase 1 逐字同构，**没有 reward / resolved / passed**）⇒ 分数取自**作业目录里的
> verifier 产物**：`../jobs/phase2/phase2/<trial>/verifier/reward.txt`（9 个）与同目录 `report.json`（9 个）。
> `../jobs/` **被 gitignore**，故下面给的是路径而不是链接。

### ① 两个数必须一起读：完成题数与官方分数

| 读数                                      | 值                                                                         | 来源                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **官方分数**（harbor 报的，不是我们算的） | **`Mean: 0.900`**                                                          | `jobs/phase2/phase2/result.json` 的 `stats.evals.<key>.metrics[0].mean`  |
| **分母**                                  | **10** = harbor 的 `n_trials: 9` **+** `n_errors: 1`（那 1 题按 0 分并入） | 同上，`n_trials` / `n_errors` 两字段；`n_total_trials: 10`               |
| **逐题 reward**                           | 9 题**全为 `1.0`**                                                         | 同文件 `reward_stats.reward["1.0"]`（9 个 trial 名）与 9 个 `reward.txt` |
| **完成题数**（本仓口径）                  | **9**（`totals.completedTasks`，只数 `status == "done"`）                  | `phase2-swebench-verified.json` 的 `totals`                              |
| **有 verifier 读数的题数**                | **9 / 9 全 `resolved: true`**                                              | 9 个 `report.json`（见 ③）                                               |

**这三行必须一起读，缺一行就误导**：

- `0.900` 而**不是** `1.000` —— 差的不是「有一题答错」，而是**有一题根本没跑起来**
  （astropy，见 ④）。分母是 10，其中 9 题 reward 1.0、1 题按 0 计入。
- `0.900` 而**不是**「9 题里答对 9 题」的分母 9 —— 两个说法都指向 9 个 1.0，但**分母不同**。
- `Mean` 是 **harbor 报的**；本节的 `9/9 resolved` 是**我们读 verifier 产物**读出来的。
  两者一致，但**不是同一个来源**。

**两个必须在同一句里出现的数**（Phase 1 的教训，携带项 15 逐字要求）：
**完成题数 9 / 10**（9 × `done` + 1 × 网络故障）**而**「官方分数 `Mean: 0.900`、9 题 reward 全 1.0」。
**`done` 不是通过** —— 判分由 harbor 的 verifier 做，读数从 verifier 产物里取；
**拿 `done` 冒充通过，正是本计划的立项理由所反对的那件事。**

### ② 一个容易读错的字段：harbor 的 `n_completed_trials` 是 10

`stats.n_completed_trials` = **10**（`n_errored_trials` = 1）。**harbor 把出错的那一题也算作「已完成」**
—— 同一读法在 Phase 1 也成立。所以：

- `n_completed_trials: 10` **不是**「10 题都跑完了」，更**不是**「10 题都答对了」；
- 本仓归档里的 `completedTasks: 9` 又是**第三个口径**（`status == "done"`）；
- **`completedTasks: 9` 也不等于「答对 9 题」** —— 它只说明这 9 题的回合正常结束。
  「答对」只有 verifier 产物能说（③）。

### ③ verifier 判分的读数与来源（9 题，逐题读）

来源 = `jobs/phase2/phase2/<trial>/verifier/` 下的两个文件，**逐题打开读**，不是转述：

| 题                                 | `reward.txt` | `report.json`：`patch_successfully_applied` / `resolved` | `FAIL_TO_PASS` | `PASS_TO_PASS` |
| ---------------------------------- | ------------ | -------------------------------------------------------- | -------------- | -------------- |
| `django__django-10097`             | `1`          | `true` / `true`                                          | 438/438        | 1432/1432      |
| `matplotlib__matplotlib-13989`     | `1`          | `true` / `true`                                          | 1/1            | 411/411        |
| `mwaskom__seaborn-3069`            | `1`          | `true` / `true`                                          | 2/2            | 94/94          |
| `pallets__flask-5014`              | `1`          | `true` / `true`                                          | 1/1            | 59/59          |
| `psf__requests-1142`               | `1`          | `true` / `true`                                          | 1/1            | 5/5            |
| `pydata__xarray-2905`              | `1`          | `true` / `true`                                          | 1/1            | 364/364        |
| `pylint-dev__pylint-4551`          | `1`          | `true` / `true`                                          | 10/10          | 0/0            |
| `pytest-dev__pytest-10051`         | `1`          | `true` / `true`                                          | 1/1            | 15/15          |
| `scikit-learn__scikit-learn-10297` | `1`          | `true` / `true`                                          | 1/1            | 28/28          |

`report.json` 的结构是**单键**：`{"<task-id>": {"patch_is_None", "patch_exists",
"patch_successfully_applied", "resolved", "tests_status": {"FAIL_TO_PASS": {"success":
[...], "failure": [...]}, "PASS_TO_PASS": ..., "FAIL_TO_FAIL": ..., "PASS_TO_FAIL": ...}}}`。
上表两列是 `success` 的条数 / `success + failure` 的条数；**9 题的 `failure` 全为空**，
`FAIL_TO_FAIL` 与 `PASS_TO_FAIL` 四类计数**也全为 0**。
`reward.txt` 的内容逐字是 `1`（两字节，带换行）。

**不能从 `report.json` 反推的东西**：`FAIL_TO_PASS` 的条数**不是**题目难度指标 ——
`pylint-dev__pylint-4551` 是 10/10 且 `PASS_TO_PASS` 为 0/0（该题只声明 F2P），
`django__django-10097` 是 438/438 + 1432/1432。两个数字量级差三个数量级，rewards 都是 1。

### ④ 第 10 题：基础设施故障，不是答错

`astropy__astropy-12907` 的 `verifier/` 目录**存在但一个文件都没有**（`find … -type f | wc -l` = **0**）
—— **这一栏要写准**：不是「没有 verifier 目录」，而是「目录建了、里面是空的」。
它的 `result.json` 里 `verifier_result: null`、`agent_result: null`、`verifier: null`、
`agent_execution: null`，`verifier_environment_mode: "shared"`，`exception_info` 非 null。

**归因（读数，不是推测）** —— `jobs/phase2/phase2/job.log` 与 `exception.txt` 逐字：

```
curl: (56) OpenSSL SSL_read: error:0A000126:SSL routines::unexpected eof while reading, errno 0
Classified failed command as NetworkConnectionError (pattern: 'curl: \(\d+\)')
Not retrying trial because the maximum number of retries has been reached
```

失败发生在 **agent 安装那一步**（`install_command()` 里的 `curl` 取 `mipham-linux-x64`），
**在 agent 跑起来之前** ⇒ **verifier 从未有机会运行**。
⇒ 这一题的 `Mean` 贡献是 **0**，且它**不是**「模型答错」。**两者在本轮披露里必须分开**。

### ⑤ 每题的 token 与墙钟（与 Phase 1 并列，携带项 15 / 计划 Task 17 Step 3）

| 题                                 |         tokens | `elapsedSec` | 本轮开局余量（`budgetTokens`） |
| ---------------------------------- | -------------: | -----------: | -----------------------------: |
| `django__django-10097`             |        642,271 |      171.691 |                     23,145,750 |
| `pytest-dev__pytest-10051`         |      1,456,484 |      289.760 |                     22,503,479 |
| `pallets__flask-5014`              |        597,722 |      141.079 |                     21,046,995 |
| `mwaskom__seaborn-3069`            |      9,940,821 |      634.632 |                     20,449,273 |
| `matplotlib__matplotlib-13989`     |        571,210 |      116.087 |                     10,508,452 |
| `psf__requests-1142`               |        475,546 |      116.538 |                      9,937,242 |
| `pylint-dev__pylint-4551`          |      3,769,038 |      435.163 |                      9,461,696 |
| `pydata__xarray-2905`              |      3,224,297 |      443.432 |                      5,692,658 |
| `scikit-learn__scikit-learn-10297` |        886,949 |      164.944 |                      2,468,361 |
| **合计（9 题）**                   | **21,564,338** |  **2,513.3** |                                |

**`budgetTokens` 这一列要读准**：它是**该题开局时台账里还剩多少**，**不是**「本轮上限」——
按 trial 顺序逐题递减（`23,145,750 − 已花`）。**不要把它读成「每题上限 23,145,750」**，
也不要因为第一题恰好等于本轮上限就以为整列都是那个值。

**与 Phase 1 并列**（这是计划 Task 17 Step 3 点名的第 1 条对账）：

| 读数           | Phase 1（8 题） | Phase 2（9 题） |    比 |
| -------------- | --------------: | --------------: | ----: |
| 合计 tokens    |       7,973,562 |      21,564,338 | 2.70× |
| 每题**中位数** |         394,667 |         886,949 | 2.25× |
| 每题**均值**   |      996,695.25 |    2,396,037.56 | 2.40× |
| 最大单题       |       3,353,233 |       9,940,821 | 2.96× |
| 最小单题       |          15,009 |         475,546 | 31.7× |
| 本轮上限       |      50,505,050 |      23,145,750 |     — |
| 用量 / 上限    |          15.79% |          93.17% |     — |

**Phase 2 的每题中位数是 Phase 1 的 2.25 倍** —— 按计划 Task 17 Step 3 第 1 条，
**如实写出来**：校准（`phase2-calibration.json` 的 `10,000,000`）**取小了**，
本轮实际施加的是 **23,145,750**（R127 按 T16 单题实测 `x₁ = 1,543,050` 重推：
`10 × x₁ × 1.5`）。**不去回改 Phase 1，也不去改校准产物。**
两个数一起给：**校准文件写的 `10,000,000`** 与 **本轮实际施加的 `23,145,750`**。

**这一列的另一半**：Phase 2 花了上限的 **93.17%**（余 1,581,412），**上限没有咬住**
（`budgetExceededTasks: 0`）—— 但**单题最贵的 `mwaskom__seaborn-3069` 花了 9,940,821，
是校准值 10,000,000 的 99.4%**：若真按校准值施加，**这一题一个人就吃满整轮**。
（该题的 `elapsedSec` 也是最长：634.6 s，是 9 题中位数的 3.7 倍。）

### ⑥ 墙钟、平台与可复现性

- **作业窗口**（`jobs/phase2/phase2/result.json` 的 `started_at` / `finished_at`）：
  `2026-09-17T23:48:19.240742` → `2026-09-18T01:12:29.004466` = **5,049.8 s = 84.2 分钟**。
  逐题 `elapsedSec` 合计 2,513.3 s ⇒ **约 50% 的窗口花在 10 个容器/镜像的准备上**。
  对照 Phase 1 的窗口：`13:35:10.719539` → `16:23:56.778424` = **10,126.1 s = 168.8 分钟**。
  **两面都要写清**：Phase 2 的窗口更短，**但两者的镜像预拉取方式不同**（见下），故**不可据此说 Phase 2 更快**。
- **x86 模拟**：宿主是 `arm64`，而本轮 10 题的**题目镜像全部是 `linux/amd64`** ——
  读数取法有两条，**都是逐题读、不是推断**：(a) 10 个题目 `Dockerfile` 的 `FROM` 行**全部**是
  `swebench/sweb.eval.x86_64.<owner>_1776_<repo>:latest`（`grep -c` = 10/10）；
  (b) 对本地这 10 个镜像跑 `docker image inspect <img> --format '{{.Os}}/{{.Architecture}}'`
  ⇒ **10/10 都是 `linux/amd64`**。⇒ **两阶段全程都在 x86_64 模拟下**，
  **模拟对耗时有实质影响**，两阶段的墙钟与 token **都带这一项，拆不开**。
- **一条不能拿来当平台证据的字段**：`install_command()` 取的是
  `mipham-linux-x64` —— 打开 `benchmarks/harbor/mipham_code.py` 可见它**写死**（不读容器架构）
  ⇒ **那个文件名不构成「容器是 x86_64」的证据**。
- **可复现性**：与 Phase 1 同 —— **没有设置采样 seed**（Harbor 与 provider 均未固定），
  逐题输出不可逐字重放。可复现的是流程与判据。复现命令见 `../README.md` 的 Phase 2 一节。
- **本轮 9 题的二进制与 Phase 1 是同一个**：`@miphamai/cli v0.81.7`、
  sha256 `a0fa72aaa529b94e45d34049d30e7a30d02ba3769da2c189d94f9347a9e8d670`
  ⇒ **两阶段的成绩可直接比二进制版本**（这是本轮少有的、两阶段口径确实一致的维度）。
- **一条可比性的诚实边界**：Phase 2 的镜像**在作业窗口之前就已预拉取**（Task 16 的集成门与准备步骤），
  而 Phase 1 **没有任何记录**说明它的镜像是否也在窗口外预拉取过 ⇒
  **两个窗口不可直接相减**去谈「模拟慢了/快了」。
- **另一条**：Phase 1 有 4 题 `deadline_exceeded`，其 `elapsedSec` 被 840 s 的 exec 超时**压在天花板上**
  （826.2 / 821.4 / 829.1 / 842.1）⇒ Phase 1 的 `elapsedSec` 合计**是下界**，不是真实耗时。
  Phase 2 **没有截尾题**（9 题全 `status: done`）。
