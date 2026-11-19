# 分析准确性评测集（原型）

> 语料：2026-11-18 一次 megasystem 分析，以及随后两位核对者（外部专家 + 模型自纠）给出的逐条判定。
> 目标不是「证明谁对谁错」，而是把「答案能不能由一条命令产出」变成可复跑的判据。

## 为什么要有它

那份分析的结论层基本成立（方向 9/10），但**事实项层只有 13/19 精确**：失准的全部集中在计数、行号、
全称断言上。这些错误没有一条是「模型不知道答案」，而是**没去量**或**只读了半条链**。

同类错误无法靠「再问一遍」发现 —— 需要一条**能自己失败的判据**。所以每个用例都携带一条
shell `probe`，它的**输出就是真值**。

## 用例形状

`cases.jsonl`，一行一条：

| 字段                         | 含义                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `id`                         | `A-01` …                                                          |
| `form`                       | 错误形态 `E1`–`E6`；`control` 表示该条原主张是正确的（负控）      |
| `origin`                     | 在 2026-11-18 报告里的原编号（`P0-1a` 等）                        |
| `klass`                      | `reading`（读数） / `judgment`（判断）                            |
| `question`                   | 交给被测代理的问题，**不含答案**                                  |
| `recorded_claim`             | 原报告当时的主张                                                  |
| `recorded_verdict`           | `right` / `wrong` / `misstated` / `unsupported`                   |
| `cwd`                        | 相对 `megasystem/` 的工作目录                                     |
| `requires`                   | 可选；依赖缺失时**跳过**而不是判红                                |
| `probe`                      | shell 命令，**输出即真值**                                        |
| `match`                      | `digits`（取首个整数，容忍千分位与「零」） / `contains` / `exact` |
| `expect`                     | 期望输出                                                          |
| `control` / `control_expect` | 可选；零命中类用例的正对照                                        |

### 错误形态

| 代码 | 形态                 | 例                                      |
| ---- | -------------------- | --------------------------------------- |
| E1   | 目测当计数           | 「48 处」实为 65                        |
| E2   | 文档自述当实测       | 「573 tests」抄自 CLAUDE.md             |
| E3   | 见调用点就反推调用链 | 「各自直连」实为 Engine 优先 + fallback |
| E4   | 全称断言无判据       | 「集成测试恒绿」实有 skipif             |
| E5   | 漏检                 | 漏掉 `shared/pyproject.toml:24` 的 ruff |
| E6   | 计数口径漂移         | `def test_` ≠ collected；100 vs 101     |

## 用法

```bash
# 1) 真值是否仍成立（用例自身的证伪）
python3 -m benchmarks.analysis.runner verify

# 2) 取出问题（答案已剥离），供被测代理作答
python3 -m benchmarks.analysis.runner questions > /tmp/q.jsonl

# 3) 打分，按形态与类别分组
python3 -m benchmarks.analysis.runner score /tmp/answers.jsonl
```

`answers.jsonl` 每行 `{"id": "A-01", "answer": "65"}`。

兄弟仓库不在默认位置时：

```bash
MIPHAM_MEGASYSTEM=/path/to/megasystem python3 -m benchmarks.analysis.runner verify
```

## 两条硬约定

1. **零命中必须配正对照。** 「0 个匹配」与「探针压根没读到那个文件」打印的是同一个读数。
   `A-15`（零 `import httpx2`）配 `import` 命中 438 作控制；`A-16`（六仓零 lint）配 `pytest` 命中 6。
   测试 `test_zero_expectation_cases_carry_a_positive_control` 守住这条。
2. **所有 probe 钉在提交上，不指向 HEAD。** 报告写完的当天下午（16:53–19:05）六个仓库就合并了修复分支。
   任何指向 HEAD 的 probe，量的都是「已经被修过的树」—— 会把对的报告判成错的。用例描述的是
   **当时的主张**，探针就必须描述当时的对象。

## 新增一条用例

1. 写一句**答案唯一**的问题；
2. 写一条能在兄弟仓库里跑出那个答案的命令，把 `expect` 设成它**当下**的输出；
3. `form` 选形态（正确主张用 `control`），`origin` 写上来源；
4. 跑 `verify`，必须 `ok`；`expect == "0"` 时必须补 `control`。

## 已知边界

- **只覆盖可机械判定的主张**：计数、行号存在性、某字符串出现与否。E3 那种「调用链」只能靠
  `contains` 近似，判不了推理质量。
- **需要 `megasystem/` 兄弟仓库**（含未推送的 `astra-khadga`）。缺失时 `A-08` `A-17` 跳过，其余照跑。
- **不是 CRSI eval harness 的替代**：`apps/cli/src/core/eval-harness.ts` 冻结的是**规则与边界契约**，
  这套冻结的是**读数与判断**。两者共用的原则是「分数不退化」，但对象不同。
- 用例集是**种子**：18 条足以证明机制，不足以宣称准确率。扩到 50+ 条之前，任何百分比都只带分母看。
