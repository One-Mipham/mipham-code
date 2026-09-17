# T2 规格修订申请 —— 五条分歧（2026-09-17）

> **性质**：本文件是**申请**，不是规格。`docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md`
> 是已批准文档，本次**一字未改**（本笔对它的改动量：0 字节）。是否接受以下五条，由用户裁决。
>
> **本文只申请，不改动任何已落地读数**：五条分歧在执行期一律**按实测走**，且已披露在
> `benchmarks/README.md`（Phase 1 一节 + Phase 2 一节）与 `benchmarks/results/README.md`（Phase 2 逐条核对）。
> 本文的工作是**把分歧本身写成可评审的对象**，而不是把规格悄悄改成实测的样子 ——
> 「一条按对象 A 写的句子，被应用到对象 B 上」若只在会话里裁决，公开读者看不到。

## 〇、口径

- 每条给四个元素：**规格原文位置 / 实测读数 / 复核命令 / 建议改法**。
- **行号是本文写就时的坐标**，与**内容锚点**并列给出 —— 行号会随文档生长而漂移，锚点不会。
- 全部命令在**仓库根**跑。用 `/usr/bin/grep`，**不要**用交互式 `grep`（本机它是 ugrep 包装器，读数不同）。
- 网络读数取证时间：**2026-09-18**，每条自带命令。
- **本文不是「纠错清单」**：五条里没有一条断言规格「写错了」。①～④ 是**句子与对象对不上**
  （或**缺少对象**），⑤ 是**形状与消费方式对不上**。两类都不是笔误。

---

## 一、「官方现役数据集 66 题」vs 实测 **89** 个任务目录

### 规格原文位置

- 文首 `:8`（内容锚点：`> **范围外**: route B 无头一次性 CLI、ACP 协议、跑满官方全量数据集（现役 **66 题**）`）
- §〇 `:14`（锚点：`本轮 spike 已把仪器验通（官方现役数据集 **66 题**、预置镜像、oracle 基线 1.000）`）
- §七 第 10 条 `:359-365`（锚点：`10. **本文原记「54 题数据集 / 全量 54 题」，2026-09-16 复核后订正为 66 题**`）

### 实测读数

本机落地的是**另一个对象**：

```
$ ls -d benchmarks/.datasets/terminal-bench/*/ | wc -l
89
```

而 `66` 也有自己的对象，且**本次独立复现成功**（规格 §七#10 记的是「9,553 字节 / `[[tasks]]` 恰 66 次」）：

```
$ curl -sS -o /tmp/t18_dataset.toml -w 'http=%{http_code} bytes=%{size_download}\n' \
    https://raw.githubusercontent.com/harbor-framework/terminal-bench/main/tasks/dataset.toml
http=200 bytes=9553
$ /usr/bin/grep -c '^\[\[tasks\]\]' /tmp/t18_dataset.toml
66
```

**两个数各自都对，对象不同**，而且这次能**指名到具体仓库**（此前只是「可能都对」的推测）：

| 读数   | 对象                                                           | 取证                                                                                 |
| ------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **66** | `harbor-framework/terminal-bench` 的 `tasks/dataset.toml`      | HTTP 200 / **9,553 字节** / `[[tasks]]` **×66**                                      |
| **89** | `harbor-framework/terminal-bench-2` 仓库**根目录**下的任务目录 | `type=='dir'` 计数 = **89**（另有 3 个文件：`.gitignore` / `LICENSE` / `README.md`） |

**并且这 89 个目录名与本机落地的那 89 个目录名逐字相等**（不是抽样、不是「数量相同」）：

```
$ python3 - <<'PY'
import json,os,urllib.request
d=json.load(urllib.request.urlopen("https://api.github.com/repos/harbor-framework/terminal-bench-2/contents/"))
up={x['name'] for x in d if x['type']=='dir'}
base='benchmarks/.datasets/terminal-bench'
loc={n for n in os.listdir(base) if os.path.isdir(os.path.join(base,n))}
print('upstream=',len(up),'local=',len(loc),'equal=',up==loc)
PY
upstream= 89 local= 89 equal= True
```

⇒ 本机下载的 `terminal-bench@2.0` **就是那个 89 目录的仓库**；`66` 是**另一个仓库**里一份清单文件的条目数。

**附带更正一处上游命名**：计划「规格分歧」第 1 条把 `66` 归给 `laude-institute/terminal-bench-2`
（计划 `:40`），而规格归给 `harbor-framework/terminal-bench`（规格 `:360`）。机器读数说**两个名字指的不是同一个仓库**：
`laude-institute/terminal-bench-2` 已 **301 永久重定向**到 `harbor-framework/terminal-bench-2`
（HTTP 响应逐字：`"message": "Moved Permanently"`，`url: https://api.github.com/repositories/1063848495`
⇒ 该 id 的 `full_name = harbor-framework/terminal-bench-2`），**而这个仓库里没有 `tasks/dataset.toml`**
（`contents/tasks/dataset.toml` → `404 Not Found`）。带 66 的那一份在**不带 `-2`** 的 `terminal-bench` 仓库里。

### 复核命令

```bash
cd <repo root>
ls -d benchmarks/.datasets/terminal-bench/*/ | wc -l                    # 89
curl -sS -o /tmp/t18_dataset.toml -w 'http=%{http_code} bytes=%{size_download}\n' \
  https://raw.githubusercontent.com/harbor-framework/terminal-bench/main/tasks/dataset.toml   # 200 / 9553
/usr/bin/grep -c '^\[\[tasks\]\]' /tmp/t18_dataset.toml                 # 66
curl -sS "https://api.github.com/repos/laude-institute/terminal-bench-2" | head -3   # Moved Permanently
```

### 建议改法

**不去裁定哪个数字「对」—— 两个都对，改的是句子的对象**。建议把规格里两处「官方现役数据集 66 题」
改成**指名对象**的写法，例如：

> 跑满官方全量数据集（`harbor-framework/terminal-bench` 的 `tasks/dataset.toml`，实测 `[[tasks]]` 66 条；
> Harbor registry 的 `terminal-bench@2.0` 条目实测落盘 **89** 个任务目录 —— 两个读数对象不同，见 §七#10）

并在 §七#10 补一句：66 的取证对象是**另一个仓库**，与本机落地的 89 目录**不是同一个对象**
（89 目录名与 `harbor-framework/terminal-bench-2` 根目录逐字相等）。**不把 66 换成 89**
—— 那是把「一个对象的读数」冒充成「另一个对象的读数」，正是 §七#10 自己反对的那件事。

---

## 二、标题里的「Terminal-Bench 4.0」vs 实际是 **2.0**

### 规格原文位置

- 标题 `:1`（锚点：`# T2 — 公开一份可复现的基准成绩（Terminal-Bench 4.0 / Harbor）`）
- §〇 `:14`（锚点：`T2 要交的是一份**可复现、且经得起辩护**的 Terminal-Bench 4.0 成绩`）

### 实测读数

被执行的对象**叫 2.0，不叫 4.0**：

```
$ /usr/bin/grep -o '"dataset": "[^"]*"' benchmarks/results/phase1-terminal-bench.json | head -1
"dataset": "terminal-bench@2.0"
```

上游自己的 README 第一行也这么写（`harbor-framework/terminal-bench-2` @ main）：

```
$ curl -sS https://raw.githubusercontent.com/harbor-framework/terminal-bench-2/main/README.md | head -1
# Terminal-Bench 2.0
```

⇒ 「4.0」在两个可查的对象里都**没有对应物**：本地归档的 `dataset` 字段、上游 README 首行，都是 2.0。

### 复核命令

```bash
cd <repo root>
/usr/bin/grep -o '"dataset": "[^"]*"' benchmarks/results/phase1-terminal-bench.json | head -1
curl -sS https://raw.githubusercontent.com/harbor-framework/terminal-bench-2/main/README.md | head -1
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://raw.githubusercontent.com/harbor-framework/terminal-bench-2/main/tasks/dataset.toml   # 404（见第①条）
```

### 建议改法

标题与 §〇 的「Terminal-Bench 4.0」改为 **`Terminal-Bench 2.0`（registry 条目名 `terminal-bench@2.0`）**，
并在文案里统一用 registry 条目名 `terminal-bench@2.0`（它才是被执行的那个对象）。
若「4.0」有其来源（例如某次口头命名），建议在 §七 留一行注明「本文曾用 4.0 称呼它」——
**删掉一个查不到出处的名词，比留着它继续被引用更安全**。

---

## 三、规格**没有**数据集下载那条代理链路的披露

### 规格原文位置

规格全文 `代理` 命中 **5 处**，逐条列出（这就是本条的范围证据）：

```
$ /usr/bin/grep -n "代理" docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md
164:Docker Desktop 把宿主机 loopback 代理给了 `host.docker.internal` ⇒ 容器内
166:（`172.17.0.1` 不通；`192.168.65.254` 通，同一个代理。）
273:国内直连、无需代理**。对照 `api.anthropic.com:443` ❌ 不通（须经 `host.docker.internal:7897`）——
274:**这正是不选境外模型的原因**：可复现性不该依赖一条代理链路。
337:2. **§3.5 的百行 WS 客户端是估算**，未实测容器内可否用 pip 装 `websockets`（容器可联网走代理，但该路径未验证；手写是**不依赖网络**的那条）。
```

五处**全部**在讲**容器 → 宿主**的那条链路（Ollama 的 `host.docker.internal`，以及
`api.anthropic.com` 与 `api.deepseek.com` 的对照）—— 即**模型调用**那一侧的代理。
**规格没有一处**提到**数据集下载**在**宿主机上**走代理（`127.0.0.1:7897`，`github.com` 被墙）。

### 实测读数

数据集下载在**本机**必须走代理；模型调用不走。两条网络依赖是**不同的链路、不同的进程、不同的方向**：

- 下载：`harbor datasets download`（**宿主**进程）→ `github.com`，**必须** `127.0.0.1:7897`；
- 模型：适配器（**宿主**进程）→ `api.deepseek.com:443`，规格 `:273` 已实测「TLS 1.3 / 0.96s 国内直连、无需代理」；
- 这两条都不在容器里 —— 容器侧的那条（`host.docker.internal:11434`）是规格已经写到的第五条。

### 复核命令

```bash
cd <repo root>
/usr/bin/grep -n "代理" docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md   # 5 处，见上
/usr/bin/grep -n "7897" docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md   # 仅 :273，且说的是容器→宿主
```

### 建议改法

**只申请补一条，不改已写的五处**：在规格的披露/限制一节加一行，说明**数据集下载**在宿主侧
依赖一条代理链路（`github.com` → `127.0.0.1:7897`），而**模型调用不依赖**它 ——
即规格自己的原则「可复现性不该依赖一条代理链路」（`:274`）**对模型调用成立，对数据集获取不成立**，
两者必须**分开披露**，不能合成一句「都要代理」或「都不需要」。

> **一句题外的自我订正（不申请改任何东西）**：计划「规格分歧」第 3 条把这条写成
> **「规格没有任何代理披露」**（计划 `:42`）。按上面 5 处命中，这句话**对象写宽了**：
> 规格**有**代理披露，缺的是**下载这一条链路**的。本申请按**精确范围**写（本节），
> 计划那句的宽窄问题记在 T18 报告里，**不就地改计划正文**（不在本任务的授权范围内）。

---

## 四、规格通篇**没有** SWE-bench 阶段

### 规格原文位置

规格全文没有 SWE-bench —— 即「**缺少对象**」，而不是「某句写错」。**零命中必配正对照**：

```
$ /usr/bin/grep -ci "swe.\?bench" docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md
0
$ /usr/bin/grep -ci "swe.\?bench" benchmarks/README.md      # 正对照：同一条管道在同一棵树里能命中
12
```

### 实测读数

Phase 2 是**真实发生过**的一轮执行，它的唯一权威描述在计划里，规格里零字：

- `benchmarks/jobs/phase2/phase2/` 下 **10** 个 trial 目录（含 `pallets__flask-5014__4qvoGWk`、
  `astropy__astropy-12907__T8b4Vq4` 等），作业级 `stats` 现为 `n_trials: 9` + `n_errors: 1`；
- 数据集为 `benchmarks/.datasets/swebench-verified/`（500 个任务目录）；
- 用户的追加指令是「两个都测」（计划「规格分歧」第 4 条已记录）。

### 复核命令

```bash
cd <repo root>
/usr/bin/grep -ci "swe.\?bench" docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md   # 0
/usr/bin/grep -ci "swe.\?bench" benchmarks/README.md                                            # 正对照 > 0
ls -d benchmarks/jobs/phase2/phase2/*/ | wc -l
ls -d benchmarks/.datasets/swebench-verified/*/ | wc -l
```

### 建议改法

在规格里补**一段**（不必扩充成完整设计）说明：T2 的范围于 2026-09-16 由用户追加为
**Phase 1 = Terminal-Bench + Phase 2 = SWE-bench Verified**，Phase 2 的设计与读数以计划
`docs/superpowers/plans/2026-09-16-t2-harbor-adapter.md` 与
`benchmarks/README.md` 的 Phase 2 一节为准，本规格的 §1～§五 只描述 Phase 1。
**不在规格里复述 Phase 2 的数字** —— 复述就是第三份拷贝，而本仓的教训是「抄成两份的那一份一定会先腐烂」。

---

## 五、`10 ×` 被写成**每题**的放大因子，却消费在**整轮共享池**里

> 本条**不在**计划「规格分歧」原有的四条里 —— 它是 T15 审查时的新发现，由控制器裁决
> 写进本申请作为第 5 条。它与此前四条**同属一类**：**一条按对象 A 写的句子，被应用到对象 B 上**。

### 规格原文位置

**规格这一侧是清楚的，含糊出现在计划里** —— 先把两边都读出来：

- **规格 §六「成本上限」行 `:321`**（内容锚点：`**准绳 = token**：整轮（10 题 × k=1）总 token 上限 **50.5M**`）
  ⇒ 规格把上限的对象写作**整轮**、单位写作 **token**、值写作 **50,505,050**（落地为
  `benchmarks/budget.py:18` 的 `DEFAULT_CEILING = 50_505_050`，并由 `benchmarks/run-benchmark.sh:108`/`:110`
  的 `${MIPHAM_LEDGER_CEILING:-50505050}` 兜底）。
- 含糊在**计划**的规则句 `:3293`（内容锚点：`上限 = 10 ×（Phase 1 已完成题目的**每题材 token 中位数与均值中的较大者**，向上取整到 10 万）。取较大者是让上限偏向不中止`）
  —— 名词是**每题**（「每题材 token …」）、系数 `10` 是**题数**，推出来的却是**整轮**量。
- 计划 `:3298`（锚点：`**没有取整**`）与 `:3301`（锚点：`**实际落了哪一组**`）记的是实现侧另两处不一致，
  与本条**不是一件事**（那两处是「脚本不实现规则句」，本条是「规则句的量纲」）。

### 实测读数

**`10 ×` 是每题形状，而消费点是整轮共享池** —— 两处都是机器读数：

```
$ sed -n '1,10p' benchmarks/budget.py
"""Job-level token ledger (spec §六).

Harbor runs one agent instance per task, so a job-level ceiling cannot live in
any instance. This is a file plus an exclusive lock: each task's budget is the
remaining headroom, so the job stops at the ceiling instead of at whichever
task happens to overshoot it.
"""
```

```
$ python3 -c "import json;d=json.load(open('benchmarks/results/phase2-calibration.json'))['derivation'];print(d['per_task_mean'], d['sets']['C']['maxOfMedianMeanTimes10'])"
996695.25 9966952.5
```

⇒ `10 ×` 均值 = **9,966,952.5**，而落地上限 = **10,000,000**（向上取整到 10 万）
⇒ **整轮余量 = 33,047.5 token，占上限的 0.330475%**。
**而 Phase 2 恰好是 10 题** ⇒ **`10 ×` 被题数精确抵消**：
`10 × 单题均值` 与「10 题各花单题均值」消费的是同一笔池子。

同一个「整轮 token 上限」在四处是四个数，**四个数各自都有出处**（本条不裁决哪个「对」）：

| 值              | 出处                                                      | 取法                                        |
| --------------- | --------------------------------------------------------- | ------------------------------------------- |
| **50,505,050**  | 规格 §六 / `budget.DEFAULT_CEILING`                       | 由「≤ $200 整轮 ÷ 最贵费率」反推            |
| **10,000,000**  | `benchmarks/results/phase2-calibration.json` 的 `ceiling` | 计划规则句 × Phase 1 真 usage               |
| **9,966,952.5** | 同上，**未取整**的那一步                                  | `10 × 996,695.25`                           |
| **23,145,750**  | **实际施加**的那个                                        | `10 × 1,543,050 × 1.5`，由 T16 单题实测重推 |

最后一行的输入来自 T16 在同一 harness、同一 x86 模拟平台上真跑的那一题
（`x₁ = 1,537,200 + 5,850 = 1,543,050`，比 Phase 1 单题均值高 **54.8%**）——
**换一个输入就换一个上限**，而这四个数**都叫「Phase 2 的 token 上限」**：这正是量纲没写清的代价。

**后果是预测，不是实测 —— 且它的可迁移性未知。**本申请**不下这个结论**：
Phase 1 最贵的四题是**编译型任务**（`build-pov-ray` / `build-pmars` / `build-cython-ext` 一类），
与 SWE-bench 的「读代码 → 改 → 跑测试」**形态不同** ⇒ 「Phase 2 会被咬住」只能写成**预测**，
**不能**当作已有读数使用。

**第一手读数在哪（这条预测的实测入口）**：同一套 harness、同一个 x86 模拟平台上**真跑过**的
SWE-bench 单题用量与墙钟，就在仓库里 —— 例如 `pallets__flask-5014`：

```
$ python3 -c "
import json;d=json.load(open('benchmarks/jobs/phase2/phase2/pallets__flask-5014__4qvoGWk/result.json'))
a=d['agent_result'];print(a['n_input_tokens'], a['n_output_tokens'], a['metadata']['mipham']['elapsedSec'])"
592103 5619 141.079
```

（逐题读数已披露在 `benchmarks/results/README.md` 的 Phase 2 一节；本申请不复制那张表。）
**指向它**（而不是转述它），是因为这张表**每次重跑都会变**，而「指向哪一张表」不会。

### 复核命令

```bash
cd <repo root>
sed -n '1,10p' benchmarks/budget.py
/usr/bin/grep -n "上限 = 10 ×" docs/superpowers/plans/2026-09-16-t2-harbor-adapter.md
/usr/bin/grep -n "整轮（10 题 × k=1）总 token 上限" docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md
/usr/bin/grep -n "DEFAULT_CEILING" benchmarks/budget.py
python3 benchmarks/calibrate-phase2.py --check      # 复算 ceiling 并逐字段比对已提交产物
python3 - <<'PY'
import json
a = json.load(open('benchmarks/results/phase2-calibration.json'))
d = a['derivation']
print(a['ceiling'], 10 * d['per_task_mean'], a['ceiling'] - 10 * d['per_task_mean'])
t = json.load(open('benchmarks/jobs/phase2-gate-attempt2/phase2-gate-attempt2/'
                   'pallets__flask-5014__uXpLmU7/result.json'))['agent_result']
x1 = t['n_input_tokens'] + t['n_output_tokens']
print(x1, 10 * x1 * 1.5, x1 / d['per_task_mean'] - 1)
PY
```

### 建议改法（**只陈述形状，不给新公式**）

**本申请不重定 Phase 2 的上限**（也不给新公式）—— 那个数由 T15 按裁决算出，
改它等于让校准失去意义；`benchmarks/results/phase2-calibration.json` 的 `rule` 字段是**记录**，一个字不改。

申请的只是**形状**。**规格这一侧不需要改**（`:321` 已经把对象写成「整轮」、单位写成 token），
要改的是**计划那句**：把它的名词与目标对齐，例如把「上限 = 10 ×（…每题材 token 中位数与均值中的较大者…）」
写成「**整轮上限 = 题数 ×（每题 token 的中位数与均值中的较大者…）**，逐题预算 = 池子的剩余额度」——
即让**系数 `10` 与题数的同一性显式**，而不是让读者自己发现。建议在规格 §六 只补**一句交叉引用**：

> 上限的量纲是**整轮**（job-level 共享池）—— 见 `benchmarks/budget.py` 的 `Ledger` 语义：
> **逐题预算 = 池子的剩余额度**，不是每题各有一份。**本轮不改数值，只登记形状。**

**并如实登记一条「论证不完整」**（来自 T15 审查的 Important I1，**不是**「数错」）：

> 产物 `benchmarks/results/phase2-calibration.json` 的 `selection.grounds[1]`
> 用「上限必须高于实际可能的整轮花费，否则一开跑就可能中止」这个标准**否决了集合 A**
> （A 给出的上限 700,000，小于 Phase 1 单题最大实际花费 3,353,233 的 1/4），
> **却没有把同一标准施于被选中的集合 C** —— 按同一标准，`10,000,000` 对
> 「10 题 × 均值 996,695」也只是**勉强够**（余量 0.33%），而那个均值**本身就是下界**
> （产物自己的 `lowerBoundCaveat` 已如实披露：被时钟截断的 4 题，其 usage 是下界）。
> **`ceiling` 的值本身是对的、取自规则句；不完整的是那条论证的适用范围。**

**一处范围提示（只作知会，不改任何产物）**：产物 `deviation.why` 结尾那句自指式的
「三组数与选中项见 derivation，这里不复制」**经机械核过为真**；但同一句里出现字母枚举
「（A / B / C）」并复述了 C 的选取理由 ⇒ **离「被自己的枚举推翻」只差一格**。
**本申请不改 `phase2-calibration.json` 一个字**（它是产物，不是本文档）。

---

## 附：本申请所依据的**可重跑脚本**

「规则句说要这样算，而计划里那段脚本实际那样算」这个论证，**没有可重跑的脚本就只剩主张**。
本申请附 `benchmarks/calibrate-phase2.py`（标准库，**零新增第三方依赖**）：

```bash
cd <repo root>
python3 benchmarks/calibrate-phase2.py            # 打印 derivation 子树
python3 benchmarks/calibrate-phase2.py --check    # 与已提交产物逐字段比，不一致则非零退出
```

`--check` 的期望输出逐字为
`derivation matches benchmarks/results/phase2-calibration.json (ceiling 10000000)`。
它**只读**，从不写那个产物 —— 产物是记录，脚本只是「记录是怎么算出来的」。
