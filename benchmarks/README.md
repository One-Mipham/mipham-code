# 公开基准 · Phase 1（Terminal-Bench）

> 本文件是 Phase 1 的**对外披露口**：复现命令、选题规则、**五条强制披露（spec §4.1）全文**、
> 规格分歧四条、仪器与平台、已知限制。
>
> 逐题的**内部核对记录**（`usage` 与 `sessionCounters` 的逐题对账、成本推算过程、一并记下的
> 两条事实）在 [`results/README.md`](results/README.md) —— 本文件不复述它。**但本文件确有**逐题的
> `status` 与 tokens（§三 ③）：那是披露 ③ 本身强制要求的一张表，不是对那份记录的复制。
> 抄成两份的那一份一定会先腐烂，这是本仓「假主张要按拷贝修」的教训。
>
> **自 T18 起，本文件同时承载 Phase 2（SWE-bench Verified）的披露** —— 追加在本文件
> **末尾**的「公开基准 · Phase 2」一节。**H1 与以上各节标题仍是 Task 14 写下的 Phase 1 原文，
> 逐字未动**：下面的「五条强制披露」「规格分歧」「仪器与平台」「已知限制」讲的是 Phase 1，
> Phase 2 的同名内容在末尾那一节里另起。

## 结论

Phase 1（`terminal-bench@2.0`，10 题，`k=1`）跑完：harbor 建了 10 个 trial，
**8 题跑到了 agent 结果，另 2 题没有结果文件**。harbor 报的**官方分数**是 `Mean: 0.000`
—— 8 题的 reward **全为 0.0**。8 题合计 **7,973,562 tokens**，是 50.5M 上限的 **15.79%**
（上限一次都没有咬住）。

- 结果文件：[`results/phase1-terminal-bench.json`](results/phase1-terminal-bench.json)
- 逐条核对：[`results/README.md`](results/README.md)

## 一、复现命令

**两条网络依赖分开写。** 代理**只**出现在数据集那一条 —— 本机 `github.com` 被墙，而模型调用
走 `api.deepseek.com:443`（实测 TLS 1.3 / 0.96s 国内直连），**必须无代理**：代理变量若渗进
容器，会把模型调用一起带偏。

### 1. 数据集（唯一需要代理的一条）

```bash
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
  harbor datasets download terminal-bench@2.0 -o benchmarks/.datasets
```

落地 **89 个任务目录**（见「四、规格分歧」第 1 条）。`benchmarks/.datasets/` 被
`benchmarks/.gitignore` 忽略，**不随仓库分发**，须由这条命令重新取得。

### 2. 跑分（无代理）

```bash
export DEEPSEEK_API_KEY=...        # 只写变量名；值不进代码、不进日志、不进提交
benchmarks/run-benchmark.sh --phase 1
```

[`run-benchmark.sh`](run-benchmark.sh) 依次做五件事：

1. **数据集**存在性检查（不存在才下载，代理只挂在那一条命令上）；
2. **选题重算与断言** —— 从下载下来的目录重算当轮选题，与记录逐题比对，**不一致即拒跑**；
3. **账本**初始化（`MIPHAM_BENCH_LEDGER`，默认 `results/ledger.json`，上限 50,505,050）；
4. **`harbor run`** —— `-a benchmarks.harbor.mipham_code:MiphamCode`、`-m deepseek/deepseek-v4-pro`、
   `-n 1 -k 1`、`-p <本地数据目录>`（故运行期不再取数据集）；
5. **组装结果文件** —— 经 `benchmarks.redact` 脱敏后写入 `results/`（容器原始输出留在
   `jobs/`，被 gitignore）。

## 二、选题规则（先于任何结果确定）

两条规则都**先于任何结果确定**，不含人工判断 ⇒ 结构上无法挑题。规则一旦按结果反推，
这个数字就与全量成绩不可比了 —— 读者无从分辨这是成绩还是筛选。

**Phase 1 —— 按数据集任务目录名的字典序，取前 10。**

**Phase 2 —— 同一规则、以仓库为单位：取字典序最前的 10 个仓库各自的第一题。**
变体的理由：SWE-bench Verified 的题名形如 `<owner>__<repo>-<pr>`，纯字典序会集中在排最前的
那一个 owner-repo 上（实测会从 astropy **一个**仓库里取满 10 题）—— 那是**一个**代码库，
不是十个。

**重算命令**（从下载下来的目录重算，并与记录逐题断言；`exit=0` 即一致）：

```bash
# Phase 1
python3 -m benchmarks.tasks \
  --dataset-dir benchmarks/.datasets/terminal-bench --rule first --n 10 --expect-recorded

# Phase 2
python3 -m benchmarks.tasks \
  --dataset-dir benchmarks/.datasets/swebench-verified --rule first-repos --n 10 --expect-recorded
```

规则与记录列表在 [`tasks.py`](tasks.py)；跑分脚本每轮都重算一遍，不一致就拒跑。

## 三、五条强制披露（spec §4.1）

### ① 这是 scaffold 成绩，不是模型裸能力

Harbor 提供了容器隔离、工具集与系统依赖。这一分数属于「**Mipham Code 在 Harbor scaffold
下**」，**不等于**模型自身的裸能力分数。

### ② 报的是 pass@1，不是 pass@k

`k = 1`（`harbor run -n 1 -k 1`）。本轮**没有**多次采样的信息，因此**读不出**做对率、
也读不出方差。

### ③ 每任务 tokens 与成本

tokens 来源是 **WS `usage` 消息的累加**（协议事实，不是估算）。成本写成**区间**，理由见下。

| 题                           | `status`            |         input |      output |          合计 | 成本区间（USD） |
| ---------------------------- | ------------------- | ------------: | ----------: | ------------: | --------------: |
| `adaptive-rejection-sampler` | `done`              |         6,817 |       8,192 |        15,009 |   0.033 – 0.037 |
| `cancel-async-tasks`         | `done`              |       178,296 |      11,326 |       189,622 |   0.049 – 0.163 |
| `caffe-cifar-10`             | `done`              |        28,649 |       8,879 |        37,528 |   0.036 – 0.054 |
| `circuit-fibsqrt`            | `done`              |        16,228 |       8,565 |        24,793 |   0.034 – 0.045 |
| `chess-best-move`            | `deadline_exceeded` |     1,955,973 |      48,332 |     2,004,305 |   0.234 – 1.482 |
| `build-cython-ext`           | `deadline_exceeded` |     3,331,064 |      22,169 |     3,353,233 |   0.161 – 2.286 |
| `build-pmars`                | `deadline_exceeded` |     1,733,285 |      16,075 |     1,749,360 |   0.102 – 1.208 |
| `build-pov-ray`              | `deadline_exceeded` |       591,738 |       7,974 |       599,712 |   0.045 – 0.422 |
| **合计（8 题）**             |                     | **7,842,050** | **131,512** | **7,973,562** | **0.69 – 5.70** |

**上表是 8 题的合计，不是 10 题的** —— 另 2 题没有结果文件（见「六、已知限制」），
**不可**与全量 10 题的成绩比对。

**区间怎么来的、为什么是区间而不是精确值**：`usage` 只给 `inputTokens` / `outputTokens`
**两个总数，没有 cache 命中拆分**，而命中价是未命中价的 1/30（谷段 $0.022 命中 / $0.66
未命中，每 1M）。故只能给两端：input 全命中 → 下端，input 全未命中 → 上端；output 两端相同
（$3.96 / 1M）。区间里因此有**两个**未知数：cache 命中拆分，以及**本轮落在哪个计价窗口**
（输入价那对是**谷段**价，output 按**峰段**计价 —— 若这一跑落在峰段，输入更贵，**两个端点
会一起上移**）。

⇒ **上表是「谷段输入价下的区间」，不是成本上界**，也不是「成本一定落在其中」。相对
「≤ $200 整轮」这条上限，它是 **0.35% – 2.85%**，余量极大（即便输入价高 10 倍，上端也只到
约 $52）。逐题数字与推算过程的完整记录见 [`results/README.md`](results/README.md)。

### ④ 复现命令 + seed

命令见「一、复现命令」。

**seed：本轮没有设置采样 seed**（Harbor 与 provider 均**未固定**），因此**逐题输出不可逐字
重放**。可复现的是**流程与判据** —— 数据集、选题规则、上限、适配器、计分口径、以及上面
这条命令；不可复现的是模型那一次采样的具体 token 序列。

### ⑤ 模型选型与自家模型摸底

**发布模型 `deepseek-v4-pro`（第三方）是产品判断**：真实基准走成熟模型，成绩才**可解释、
可复现**。这与自家模型摸底是**两件解耦的事** —— 选型**不是**因为「自家模型全不行」，
那个概括是**假的**。

自家模型的摸底结论**分成两份**：

| 模型                 | 结论                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `v5-pro` / `v5-apex` | **24 次采样 0 命中**（不产生 `tool_calls`）；`v5-pro` 且**编造工具调用**  |
| `v5-flash`           | 在 **31 个真实工具**上 **3/3 调对**（Glob 任务发 Glob、Read 任务发 Read） |

**决定因素是血统，不是参数量**：能调工具的是 **1.5B** 的 `v5-flash`，不能调的是 **14B** 的
`v5-apex`。`v5-flash` 的底座原生带 function calling；`v5-pro` / `v5-apex` 走的是上游本就
不支持 function calling 的蒸馏系。⇒ `v5-pro` / `v5-apex` 的失败是**能力天花板，不是集成问题**。

**一条必须一并读的边界**：`v5-flash` 那 3/3 测的是**首轮** —— 给工具、模型正确发出
`tool_calls`。**「工具执行完、结果回灌、第二轮接着调」的多轮闭环未测**，也未带 Mipham Code
的完整系统提示。故**不能**由 3/3 推出「`v5-flash` 能跑 agent 循环」。

另需说明：`v5-pro` 那种「编造一个工具结果」的表现**比报错更坏** —— 它看起来像成功。

## 四、规格分歧四条

以下四条**逐字引自** [`docs/superpowers/plans/2026-09-16-t2-harbor-adapter.md`](../docs/superpowers/plans/2026-09-16-t2-harbor-adapter.md)
的「规格分歧（须用户裁决，本计划不擅自改规格）」一节 —— 其中的「本计划」即指该计划文件。
规格本身一字未动；差异按实测执行并披露在此。

1. **「官方现役数据集 66 题」（spec `:8`、`:14`、§七#10）** —— 实测 `harbor datasets download terminal-bench@2.0` 落地 **89 个任务目录**（`Successfully downloaded 89 task(s)`）。两个读数可能都对而对象不同：**66** 是上游仓库 `laude-institute/terminal-bench-2` 的 `tasks/dataset.toml` 里 `[[tasks]]` 的出现次数，**89** 是 Harbor registry 的 `terminal-bench@2.0` 条目；`harbor run -d terminal-bench@2.0` 实际调度的是后者。**本计划的选题规则施加在 89 上**，因为那是被调度的对象；不去断言哪个数字「对」。
2. **标题里的「Terminal-Bench 4.0」（spec `:1`、`:14`）** —— registry 里没有任何 4.0 条目；实际用的是 `terminal-bench@2.0`（entry 名 `terminal-bench`，89 题）。计划统一写 `terminal-bench@2.0`。
3. **规格没有任何代理披露** —— 而 dataset 下载在**本机**必须走 `127.0.0.1:7897`（`github.com` 被墙），模型调用走**无代理**的 `api.deepseek.com:443`（实测 TLS 1.3 / 0.96s 国内直连）。规格自己立的原则是「可复现性不该依赖一条代理链路」，所以这两条网络依赖**必须分开写进披露**。本计划的做法是把代理**只挂在数据集下载那一条命令上**（`harbor datasets download`），`harbor run` 一律用 `-p <本地目录>` 且不继承代理 —— 既分开披露，也避免代理变量渗进容器把模型调用带偏。
4. **规格通篇没有 SWE-bench 阶段** —— 用户 2026-09-16 追加「两个都测」，本计划的 Phase 2 是它的唯一权威描述。

## 五、仪器与平台

全部为 2026-09-17 实测读数（取法即命令本身，可复核）：

| 项                         | 读数                                                                                               | 取法                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| harbor 版本                | `0.23.0`                                                                                           | `harbor --version`                                                |
| 宿主架构                   | `arm64`                                                                                            | `uname -m`                                                        |
| Docker 服务端              | `arm64 linux`                                                                                      | `docker version --format '{{.Server.Arch}} {{.Server.Os}}'`       |
| **容器平台（trial 所在）** | **`linux/amd64`** —— 10 个镜像**全部**如此                                                         | `docker image inspect <img> --format '{{.Os}}/{{.Architecture}}'` |
| Mipham Code 二进制         | `@miphamai/cli v0.81.7`，sha256 `a0fa72aaa529b94e45d34049d30e7a30d02ba3769da2c189d94f9347a9e8d670` | 8 题结果文件里逐题相同                                            |

**容器基础镜像清单（10 个，逐字转录）** —— `benchmarks/.datasets/` 被 gitignore、
docker 镜像是本机状态，**两者都链接不了**，故列在此处：

```
alexgshaw/adaptive-rejection-sampler:20251031
alexgshaw/bn-fit-modify:20251031
alexgshaw/break-filter-js-from-html:20251031
alexgshaw/build-cython-ext:20251031
alexgshaw/build-pmars:20251031
alexgshaw/build-pov-ray:20251031
alexgshaw/caffe-cifar-10:20251031
alexgshaw/cancel-async-tasks:20251031
alexgshaw/chess-best-move:20251031
alexgshaw/circuit-fibsqrt:20251031
```

**必须点明的一条：宿主是 `arm64`，而 trial 跑的是 `linux/amd64` 镜像 ⇒ 全程在 x86_64
模拟下**（Apple Silicon + Rosetta）。**模拟对耗时有实质影响**，成绩要公开，这是该披露的项目。

> 注意一个容易读错的字段：`results/integration-gate.json` 里的 `dockerPlatform:
"linux/arm64"` 取自 `{{.Server.Os}}/{{.Server.Arch}}`，记的是 **docker _server_** 的平台，
> **不是 trial 容器的平台** —— 两者在本机恰好不同。**不要把它当作本轮的运行平台读。**

## 六、已知限制

1. **8 题不是 10 题。** harbor 建了 10 个 trial，其中 **2 题没有结果文件**：
   `bn-fit-modify`（`EnvironmentStartTimeoutError`）与 `break-filter-js-from-html`
   （`NetworkConnectionError`）。**故上表与「合计」都是 8 题的**。
2. **`n_cache_tokens` / `cost_usd` 未填** —— **协议不提供**：WS `usage` 只给
   `inputTokens` / `outputTokens` 两个总数，无 cache 命中拆分（这是成本只能给区间的原因）。
3. **pass@1**：`k = 1`，没有多次采样的信息。
4. **单机单次**：1 台主机、1 次运行、10 题。**10 题不可外推为全量成绩** —— 选题规则的偏差
   与小样本方差都使二者不可比。
5. **x86 模拟**（见「五、仪器与平台」）：宿主 arm64、容器 linux/amd64 ⇒ 全程 x86_64 模拟，
   **对耗时有实质影响**。原以为这是 Phase 2 才有的事，实测 Phase 1 就已经是。
6. **本轮跑的那个二进制里没有截断这个仪器** —— 8 题的 `binaryVersion` 都是 `v0.81.7`，
   而截断标记的修复不是它的祖先 ⇒ 本轮**结构上不可能**出现截断标记。这**不是**「没有发生
   截断」的证据，而是「那个标记不在这个二进制里」。
7. **这些测试与验收运行都不在 CI 里** —— `.github/workflows/` 对 python/unittest 零命中，
   且 `benchmarks/.datasets/` 被 gitignore ⇒ **单测与验收今天都只在本机跑过**。这条绿不得被
   当作「已被强制执行」引用。

## 许可与数据

本目录的代码是仓库的一部分，随仓库的 Apache 2.0 许可发布。数据集与容器镜像**不在本仓库内**
（见「一、复现命令」）；其许可与使用条款以各自上游为准。

---

# 公开基准 · Phase 2（SWE-bench Verified）

> Phase 2 的**逐条内部核对记录**（每题材 token 与墙钟、verifier 逐题读数、第 10 题的故障归因）
> 在 [`results/README.md`](results/README.md) 的 Phase 2 一节 —— 本文件不复述它。
>
> 上面 Phase 1 部分的**五条强制披露在 Phase 2 同样成立**（scaffold 成绩不是裸能力 / `k=1` 报的是
> pass@1 / 每题材 tokens 与成本 / 复现命令 + 无 seed / 模型选型理由）。逐条对应见本节「五」。

## 结论

Phase 2（`swebench-verified@1.0`，**10 题、10 个不同仓库**，`k=1`）跑完：harbor 建了 10 个 trial，
**9 题跑到了 agent 结果，第 10 题在 agent 安装阶段因网络故障中断**（见「六、已知限制」）。

**两个数必须一起读**（Phase 1 的教训）：

- **完成题数 9 / 10**（9 × `status: done` + 1 × 网络故障）；
- **官方分数 `Mean: 0.900`** —— 分母是 **10**：harbor 自己的 `n_trials: 9` **加** `n_errors: 1`，
  **出错那一题按 0 分并入**。**9 题的 reward 全为 `1.0`**。

⇒ `0.900` 而**不是** `1.000`，差的不是「有一题答错」，而是**有一题根本没跑起来**；
`0.900` 而**不是**「9 题里答对 9 题」的分母 9 —— 两个说法都指向那 9 个 `1.0`，但**分母不同**。
**`done` 不是通过**：判分由 harbor 的 verifier 做，读数取 verifier 产物（「四」）。

9 题合计 **21,564,338 tokens**，是**本轮实际施加的上限 23,145,750** 的 **93.17%**（余 1,581,412，
**上限一次都没有咬住**）。

## 一、复现命令

与 Phase 1 同构：**两条网络依赖分开写**，代理**只**挂在数据集那一条上（`github.com` 被墙），
模型调用走**无代理**的 `api.deepseek.com:443`。

### 1. 数据集（唯一需要代理的一条）

```bash
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
  harbor datasets download swebench-verified@1.0 -o benchmarks/.datasets
```

落地 `benchmarks/.datasets/swebench-verified/`（同样被 `benchmarks/.gitignore` 忽略，**不随仓库分发**）。

### 2. 选题重算与断言（不花钱）

```bash
python3 -m benchmarks.tasks \
  --dataset-dir benchmarks/.datasets/swebench-verified --rule first-repos --n 10 --expect-recorded
```

规则与 Phase 1 同节「二、选题规则」：**取字典序最前的 10 个仓库各自的第一题**，
**先于任何结果确定**。（纯字典序会从 `astropy` **一个**仓库里取满 10 题 —— 那是**一个**代码库。）

### 3. 跑分（无代理）

```bash
export DEEPSEEK_API_KEY=...        # 只写变量名；值不进代码、不进日志、不进提交
export DOCKER_DEFAULT_PLATFORM=linux/amd64
export CEILING=23145750
export MIPHAM_LEDGER_CEILING="$CEILING"
export MIPHAM_BENCH_LEDGER="$PWD/benchmarks/results/ledger-phase2.json"
bash benchmarks/run-benchmark.sh --phase 2 --fresh
```

**这三行必须分行、且每行都带 `export` —— 这不是格式偏好。** 写成链式
`CEILING=23145750 MIPHAM_LEDGER_CEILING="$CEILING" … cmd` 时，`$CEILING` 在**前一条赋值生效之前**
就被展开成空串；实测（外部命令读自己的环境，四种 shell 各跑一次）：

| shell       | 链式一行给的 `MIPHAM_LEDGER_CEILING` | 上面分行给的值 |
| ----------- | ------------------------------------ | -------------- |
| bash 3.2.57 | **空**                               | 23145750       |
| sh          | **空**                               | 23145750       |
| zsh 5.9     | 23145750                             | 23145750       |
| dash        | 23145750                             | 23145750       |

空不是报错：`run-benchmark.sh:108`/`:110` 会回落到 `${MIPHAM_LEDGER_CEILING:-50505050}`，
即 **Phase 1 的上限** —— 于是**在 bash 里复制粘贴这段的人，拿到的是一个比 23145750 松 2.2 倍的界，
而且 `--fresh` 会把上一个账本不可逆地清掉**。链式形态在 zsh 里恰好正确，所以它「在我这儿是好的」，
在读者那儿是坏的 —— 这是最难诊断的一种形状。分行 + `export` 四种 shell 全部取到 `23145750`。

**三处不可省、也不可拆到两条命令里**：

1. **`DOCKER_DEFAULT_PLATFORM=linux/amd64`**（**本机必须**）。不带它的实测代价有一次先例：
   `jobs/phase2-gate/` 那一跑 **40.4 秒、`n_trials: 0`、`n_errors: 1`（`RuntimeError`）**，
   而 **harbor 的退出码是 0** —— **退出码 0 是误导**，判据只能是「trial 有没有真跑起来」。
2. **`MIPHAM_LEDGER_CEILING`** 与 **`MIPHAM_BENCH_LEDGER`**：Phase 2 用**独立的台账**
   `results/ledger-phase2.json`，**不与 Phase 1 共用**（共用会让两次作业的用量互相吃掉对方的额度）。
3. **`CEILING` 是 `23145750`，不是校准文件里的 `10,000,000`**。两个数都写在这里：
   校准产物 `results/phase2-calibration.json` 记的是 **`10,000,000`**；
   **本轮实际施加的是 `23,145,750`**（= `10 × 1,543,050 × 1.5`，由 T16 的单题实测 `x₁` 重推）。
   运行期那条命令的自证是 stdout 的 `ceiling=` 行：**`23145750` 才是「参数生效」**。
   读到 **`50505050`**（脚本在 `MIPHAM_LEDGER_CEILING` 为空时的兜底 = **Phase 1 的上限**）通常就是
   参数**没送进去** —— 上面的分行写法正是为堵这个；**但也可能是盘上那个数本就是它**（上限一旦
   写盘就改不动，见本条末段）。校准产物里那个 `10,000,000` 只是校准记录，
   **从未被施加过**，见到它同样不是「生效」。

   **读到 `50505050` 之后别再重跑 —— 重跑不会修好它。** 上限在**第一次写盘时就被烙进账本**，
   此后 `--ceiling` 与 `--fresh` **都改不动它**：`budget.py:37` 用 `setdefault` ⇒ 盘上已有的
   ceiling 优先、传进来的那个被丢弃；`reset()`（`budget.py:48-49`）只清条目，ceiling 是
   **照抄旧值**写回去的。于是一个被盖成 50505050 的账本，**不做手工订正就一直是** 50505050，
   `init` 每跑一次都如实打印这个数 —— 看着像「命令没生效」，实为「在这条路径上生效不了」。
   **三条补救都实测可用，而触发条件是「文件不在」或「盘上那个数被改掉」，不是「换了路径」**：
   ① `MIPHAM_BENCH_LEDGER` 指向一个**新文件**；② **删掉这份账本、原地重建**（走的是同一条
   `budget.py:35-36` 的 `FileNotFoundError` 分支，路径没换而效果相同）；③ **手工订正盘上的
   `ceiling`**（`budget.py:37` 的 `setdefault` 届时取盘上那个新值）。①②会把旧账本里的
   **已花记录丢掉**，只有 ③ 留得住 —— 那也正是兄弟文档 `results/README.md` 对另一份账本给的
   处置。动手前先想清楚那笔支出要不要留档；**投递 `ceiling` 时别用前缀赋值**（那个坑见本条上面）。

## 二、x86 模拟的实测读数与它对墙钟的影响

**宿主是 `arm64`，而本轮 10 题的题目镜像全部是 `linux/amd64`** ⇒ **全程在 x86_64 模拟下**。
这个结论有**两条逐题读、非推断**的取法：

```bash
# (a) 题目 Dockerfile 的 FROM 行 —— 逐题点名本轮这 10 题，使打印出来的 10 行就是读数本身。
#     不能通配整个 glob：那个目录是全量数据集，有 500 个 Dockerfile ⇒ 会打出 500 行。
for t in astropy__astropy-12907 django__django-10097 matplotlib__matplotlib-13989 \
         mwaskom__seaborn-3069 pallets__flask-5014 psf__requests-1142 \
         pylint-dev__pylint-4551 pydata__xarray-2905 pytest-dev__pytest-10051 \
         scikit-learn__scikit-learn-10297; do
  grep -h -m1 '^FROM' "benchmarks/.datasets/swebench-verified/$t/environment/Dockerfile"
done
# (b) 本地这 10 个镜像自己的平台
docker image inspect <img> --format '{{.Os}}/{{.Architecture}}'
```

(a) 上面那条 `for` 循环输出 **10 行**（`… done | wc -l` = `10`，不是通配 glob 的 500 行），
全部形如 `FROM swebench/sweb.eval.x86_64.<owner>_1776_<repo>:latest`（`… done | grep -c 'sweb.eval.x86_64'` = **10/10**）；
(b) 对这 10 个镜像逐个读，**10/10 都是 `linux/amd64`**。

**一条不能拿来当平台证据的字段**：adapter 的 `install_command()` 取的是
`mipham-linux-x64` —— 它在 `benchmarks/harbor/mipham_code.py` 里**写死**（**不读容器架构**）
⇒ **那个文件名不构成「容器是 x86_64」的证据**，别拿它当第二条。

**对墙钟的影响（实测，不是估算）**：

| 读数                           | 值                                                  | 取法                                        |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------- |
| Phase 2 作业窗口               | **5,049.8 s = 84.2 分钟**                           | `jobs/phase2/phase2/result.json` 首尾时间戳 |
| Phase 2 逐题 `elapsedSec` 合计 | **2,513.3 s**（9 题，中位数 171.7 s，最长 634.6 s） | 归档逐题字段求和                            |
| Phase 1 作业窗口               | **10,126.1 s = 168.8 分钟**                         | `jobs/phase1/phase1/result.json` 首尾时间戳 |
| Phase 1 逐题 `elapsedSec` 合计 | **4,127.7 s**（8 题，中位数 547.3 s，最长 842.1 s） | 归档逐题字段求和                            |

**本节的诚实边界，两条都要写**：

1. **「Phase 2 窗口更短」不可读成「模拟对 Phase 2 影响更小」** —— 两个窗口里**有多少是镜像准备**不同：
   Phase 2 的 10 个镜像**在作业窗口之前**就已预拉取（Task 16 的集成门与准备步骤），
   而 Phase 1 **没有任何记录**说明它的镜像是否也在窗口外预拉取过。
   Phase 2 的 5,049.8 s 里有约 **50%** 不在逐题 `elapsedSec` 里（容器/镜像准备），
   Phase 1 那 10,126.1 s 的同项占比**无从对比**。
2. **两阶段都在同一模拟下**，所以**没有任何一条读数能把「模拟的代价」单独拆出来** ——
   本文件给的是**带模拟的绝对值**，不是「比原生慢 N 倍」。
3. **Phase 1 的 `elapsedSec` 合计是下界**：它有 4 题 `deadline_exceeded`，`elapsedSec` 被 840 s 的
   exec 超时压在天花板上（826.2 / 821.4 / 829.1 / 842.1）。Phase 2 没有截尾题（9 题全 `done`）。

## 三、两阶段的每题 token 对比

| 读数           | Phase 1（8 题） | Phase 2（9 题） |    比 |
| -------------- | --------------: | --------------: | ----: |
| 合计 tokens    |       7,973,562 |      21,564,338 | 2.70× |
| 每题**中位数** |         394,667 |         886,949 | 2.25× |
| 每题**均值**   |      996,695.25 |    2,396,037.56 | 2.40× |
| 最大单题       |       3,353,233 |       9,940,821 | 2.96× |
| 最小单题       |          15,009 |         475,546 | 31.7× |
| 本轮上限       |      50,505,050 |      23,145,750 |     — |
| 用量 / 上限    |          15.79% |          93.17% |     — |
| 触发上限的题数 |               0 |               0 |     — |

**Phase 2 的每题中位数是 Phase 1 的 2.25 倍** —— 如实写出来：**Phase 2 的校准取小了**。
本轮实际施加的上限经 T16 的单题实测重推过一次（`10,000,000` → `23,145,750`），
**校准产物一个字未改，Phase 1 的读数也不回改**。

这条重推的**依据**是**规格分歧的第 5 条** —— 「`10 ×` 被写成**每题**的放大因子，却消费在
**整轮共享池**里」。它**不在**本文件 §一 那四条里（那四条按 [`四、规格分歧四条`](#四规格分歧四条) 的定义
只描述 Phase 1），是 T15 审查时新发现、由控制器裁决写进修订申请的第 5 条，全文见
[`../docs/superpowers/specs/2026-09-17-t2-spec-amendments.md`](../docs/superpowers/specs/2026-09-17-t2-spec-amendments.md) §五。
**读懂它才知道校准值为什么不是施加值**，也才知道 `calibrate-phase2.py` 的推导为何与计划 Step 1 的脚本不同。

**一条要一起读的余量读数**：Phase 2 花了上限的 **93.17%**，余 **1,581,412** —— 而
**单题最贵的 `mwaskom__seaborn-3069` 一个人就花了 9,940,821**，是**校准值 `10,000,000` 的 99.4%**：
**若真按校准值施加，这一题一个人就吃满整轮。** 逐题数字见 [`results/README.md`](results/README.md)。

**一条口径说明**：归档里逐题的 `budgetTokens` 是**该题开局时台账还剩多少**，
**不是「每题上限」**。它在**台账时间序**上逐题递减（Phase 2：23,145,750 → … → 2,468,361），
但**归档里的逐题顺序是题名字典序、不是运行顺序**，所以那一列**看上去是起起落落** ——
实测按行序有**四次回升**（23,145,750 → 10,508,452 → 20,449,273 → 21,046,995 → 9,937,242 →
5,692,658 → 9,461,696 → 22,503,479 → 2,468,361）。运行顺序可由台账条目的 `at` 时间戳还原。
**不要整列读成同一个值，也不要按归档行序读成递减。**

## 四、verifier 判分的读数与来源

**来源 = 作业目录里的 verifier 产物**，逐题读，不是转述：

```bash
ls benchmarks/jobs/phase2/phase2/*/verifier/reward.txt   # 9 个
cat benchmarks/jobs/phase2/phase2/<trial>/verifier/reward.txt
```

| 读数                                                          | 值                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `reward.txt`（逐题）                                          | **9 个，内容都是 `1`**；第 10 题 `astropy__astropy-12907` **目录在、文件为空**（0 个文件） |
| `report.json` 的 `resolved`                                   | **9 / 9 全 `true`**                                                                        |
| `report.json` 的 `patch_successfully_applied`                 | **9 / 9 全 `true`**                                                                        |
| `tests_status` 的 `failure` / `FAIL_TO_FAIL` / `PASS_TO_FAIL` | **9 题全空 / 全 0**                                                                        |

**`Mean: 0.900` 是 harbor 报的**（`jobs/phase2/phase2/result.json` 的 `stats.evals.<key>.metrics[0].mean`），
**逐题 `resolved` 是我们读 verifier 产物读出来的** —— 两者一致，但**不是同一个来源**。

**一个容易读错的字段**：`stats.n_completed_trials` = **10**。harbor **把出错的那一题也算作「已完成」**
（Phase 1 同样如此）⇒ 它**不是**「10 题都跑完了」，更**不是**「10 题都答对了」。
本仓归档里的 `completedTasks: 9` 是**第三个口径**（`status == "done"`），
而它**同样不等于「答对 9 题」**。

**第 10 题的故障是基础设施，不是答错**：`jobs/phase2/phase2/job.log` 与
`astropy__astropy-12907__T8b4Vq4/exception.txt` 逐字给出
`curl: (56) OpenSSL SSL_read: … unexpected eof while reading`，被 harbor 归类为
`NetworkConnectionError`。失败发生在 **agent 安装那一步**（取 `mipham-linux-x64` 的 `curl`），
**在 agent 跑起来之前** ⇒ **verifier 从未有机会运行**（该题 `verifier_result: null`、
`agent_result: null`）。**「没跑起来」与「答错」在本披露里必须分开。**

## 五、与 Phase 1 五条强制披露的对应

| Phase 1 的披露                       | Phase 2 的对应                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| ① 这是 scaffold 成绩，不是模型裸能力 | **同样成立** —— 容器隔离、工具集与系统依赖仍由 Harbor 提供                                                                              |
| ② 报的是 pass@1，不是 pass@k         | **同样成立**：`k = 1`，**读不出**做对率与方差                                                                                           |
| ③ 每任务 tokens 与成本               | 见「三」的并列表；**成本区间与 Phase 1 同形**（`usage` 只给两个总数、无 cache 命中拆分 ⇒ 只能给区间，且**本轮落在哪个计价窗口不可知**） |
| ④ 复现命令 + seed                    | 见「一」；**同样没有设置采样 seed**（Harbor 与 provider 均未固定）⇒ 逐题输出不可逐字重放                                                |
| ⑤ 模型选型与自家模型摸底             | **同一个发布模型** `deepseek-v4-pro`（理由见 Phase 1 那一条）；自家模型那半两阶段共用，未重测                                           |

## 六、已知限制（Phase 2）

1. **9 题不是 10 题。** harbor 建了 10 个 trial，`astropy__astropy-12907` 在 **agent 安装阶段**
   因瞬时网络故障中断（`curl: (56)`，`NetworkConnectionError`）⇒ **它的分数贡献是 0，且它不是答错**。
   本轮**没有重跑它**。
2. **`Mean: 0.900` 的分母是 10，不是 9。** 见「结论」。
3. **pass@1**：`k = 1`，没有多次采样的信息。
4. **单机单次**：1 台主机、1 次运行、10 题。**10 题不可外推为全量成绩**。
5. **x86 模拟**（见「二」）：宿主 arm64、题目镜像 linux/amd64 ⇒ **全程模拟**，对耗时有实质影响。
6. **两阶段的墙钟不可直接相减**（镜像是何时拉取的，两阶段的记录不同 ⇒ 见「二」的边界 1）。
7. **`n_cache_tokens` / `cost_usd` 未填** —— 与 Phase 1 同因：WS `usage` 协议不提供 cache 命中拆分。
8. **本轮跑的那个二进制与 Phase 1 是同一个**（`@miphamai/cli v0.81.7`，
   sha256 `a0fa72aaa529…d670`）⇒ **二进制版本这一项两阶段确实一致**，可以比。
9. **这些测试与验收运行都不在 CI 里**（同 Phase 1 的第 7 条）。

## 七、上限的口径（2026-09-18 定档）

**往后各轮的 token 上限一律由美元反推，不用实测校准值。** 口径一句话：

```
ceiling = 整轮美元预算 ÷ 最贵费率
```

取**最贵费率**（`deepseek-v4-pro` 峰段 output $3.96 / 1M）是为让这条界**与用量构成无关地**成立：
无论实际是 cache 命中（$0.022/1M）还是未命中（$0.66/1M）、是输入还是输出，这个 token 数
对应的账单都不会超过那个美元预算。规格 §六 的 `50,505,050` 正是 `$200 ÷ $3.96/1M`。

**那三个数各自的语义（别再把它们都叫「Phase 2 的 token 上限」）：**

| 值             | 语义                                                            |
| -------------- | --------------------------------------------------------------- |
| **50,505,050** | **ceiling**（护栏）—— 口径如上，与题数、难度、用量构成全无关    |
| **10,000,000** | **forecast** —— 计划规则句 × Phase 1 真 `usage`，**从未被施加** |
| **23,145,750** | Phase 2 当时施加的那个（T16 单题实测 `× 1.5 × 10`）—— 见下      |

**校准值（`results/phase2-calibration.json` 里那个数）是 forecast，不是 ceiling，永不传给
`--ceiling`。** 用实测算出来的「本轮大约要花多少」当上限，等于把界落在**期望用量**上 ——
**按定义会在最后一题把自己掐掉**。2026-09-17 的 Phase 2 正是这一形态的实测：

| 读数             |            值 |
| ---------------- | ------------: |
| 施加的上限       |    23,145,750 |
| 9 题实花         |    21,564,338 |
| 余量             | **1,581,412** |
| 每题均值（9 题） | **2,396,038** |

**余量 1,581,412 < 每题均值 2,396,038** ⇒ 第 10 题只要跑起来，按均值算总花 `23,960,376`、
超上限 `814,626`；而 `budget.py` 的语义是「**逐题预算 = 池子的剩余额度**」，它会被**中途截断**。
**所以「上限一次都没有咬住」不是因为它够松 —— 是因为第 10 题在 agent 安装阶段就死了。**
（同因：`1.5` 这个余量假定每题 `2,314,575`，而实测均值比它还高 **3.5%**；最大单题 `9,940,821`
是 gate 题的 **6.44 倍**。界设得低于均值，按定义要咬住。）

⇒ **`23,145,750` 这个值的历史身份**：它当时是照 T16 的单题实测重推的，**按本条口径它本不该
被施加**。**本轮不改数值、不回改任何已提交产物** —— `results/phase2-calibration.json`
一个字不动，`results/phase2-swebench-verified.json` 里那次的 `ledger.ceiling` 也不动：
**它们是记录**。本条只定**往后各轮**的口径。

**口径与题数无关。** 换成 20 题、换成别的基准，换算方式不变（仍是 `$ 预算 ÷ 最贵费率`）；
题数只影响**要不要换一个美元档**，不影响这个口径。
