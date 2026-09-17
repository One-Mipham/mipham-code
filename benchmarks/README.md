# 公开基准 · Phase 1（Terminal-Bench）

> 本文件是 Phase 1 的**对外披露口**：复现命令、选题规则、**五条强制披露（spec §4.1）全文**、
> 规格分歧四条、仪器与平台、已知限制。
>
> 逐题的**内部核对记录**（`usage` 与 `sessionCounters` 的逐题对账、成本推算过程、一并记下的
> 两条事实）在 [`results/README.md`](results/README.md) —— 本文件不复述它。**但本文件确有**逐题的
> `status` 与 tokens（§三 ③）：那是披露 ③ 本身强制要求的一张表，不是对那份记录的复制。
> 抄成两份的那一份一定会先腐烂，这是本仓「假主张要按拷贝修」的教训。

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
