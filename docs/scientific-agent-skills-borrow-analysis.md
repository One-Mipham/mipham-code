---
title: scientific-agent-skills 借鉴定分析
type: borrow-analysis
date: 2026-08-28
author: Mipham Code（AI 辅助调研）
maintainer: One Mipham Corporation 技术委员会
status: 已完成（结论：不必要全量安装）
---

# scientific-agent-skills 借鉴定分析

> 调研对象：`K-Dense-AI/scientific-agent-skills`
> 调研维度：功能 / 安全性 / 安装必要性 / 与自有系统的重复对照
> 结论置信度：功能与安全 [高]（源自 GitHub API 与 SECURITY.md 原文）；「重复对照」[高]（源自两套系统的已读代码/结构）

---

## 结论摘要

**`scientific-agent-skills` 是一个高质量、MIT 许可、有自动化安全扫描的「科学工具使用知识库」，但对我们当前的产品形态不必要全量安装，且我们系统里没有重复的 skill——只是在「学科覆盖」层面与我们的 `mipham-science` 平台高度重叠，但两者是不同形态（知识库 vs 编排引擎）。**

---

## 一、调研对象与证据来源

| 项目            | 值                                                                                                                                                                                                                                                                     | 来源                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 仓库            | `K-Dense-AI/scientific-agent-skills`                                                                                                                                                                                                                                   | GitHub API 搜索（`q=scientific-agent-skills`，166 条结果中精确匹配第 1 位） |
| Stars / Forks   | 35,741 / 3,434                                                                                                                                                                                                                                                         | `stargazers_count` / `forks_count`                                          |
| 许可证          | **MIT**                                                                                                                                                                                                                                                                | `license.key = "mit"`                                                       |
| 语言            | Python                                                                                                                                                                                                                                                                 | `language: "Python"`                                                        |
| 仓库体积        | 约 248 MB                                                                                                                                                                                                                                                              | `size: 248459` KB                                                           |
| 创建 / 最近推送 | 2025-10-19 / 2026-08-24                                                                                                                                                                                                                                                | `created_at` / `pushed_at`                                                  |
| 官方描述        | "Turn any AI agent into an AI Scientist… 163 ready-to-use validated skills plus 100+ scientific databases covering biology, chemistry, medicine, and drug discovery. Compatible with Cursor, Claude Code, Codex, Pi, Antigravity, and the open Agent Skills standard." | 仓库 description                                                            |
| 顶层结构        | `skills/`（163 子目录）、`plugin.json`、`pyproject.toml`、`scan_skills.py`、`scan_pr_skills.py`、`SECURITY.md`、`AGENTS.md`、`tests/`、`docs/`                                                                                                                         | GitHub contents API                                                         |

> 说明：调研时 WebSearch 未配置（无 `BRAVE_API_KEY`），改用 GitHub REST API 通过 WebFetch 直接抓取；`raw.githubusercontent.com` 后半段抓取超时，因此个别 skill 全文未逐字核对——凡涉及「skill 具体内容」的表述，均以目录命名 + `rdkit` 目录结构（`SKILL.md` + `references/` + `scripts/`）为据，未逐条读 163 份正文。

---

## 二、功能分析

### 2.1 本质

这是一个 **prompt/提示词资产库**，不是模型、不是引擎。它把「一个科学家常用的 163 个工具的正确用法」打包成 skill，让 AI agent 不用现查文档就能写对这些库的代码。

每个 skill 的标准结构（以 `rdkit` 为例，confirmed）：

```
skills/<name>/
├── SKILL.md        # 主提示词（rdkit 的为 5.7 KB）
├── references/     # 参考资料（可能被 agent 当作权威内容）
└── scripts/        # 可执行脚本（bundled scripts）
```

### 2.2 skill 内容构成（按目录命名归类）

| 类别                 | 代表 skill                                                                                                                                                     | 面向场景                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 科学库用法（占大头） | `rdkit` `scanpy` `biopython` `pymatgen` `pydicom` `neurokit2` `qiskit` `pennylane` `deepchem` `diffdock` `cobrapy` `pytdc` `pysam`                             | 教 agent 正确调用生信/化学/材料/量子库 |
| 论文 / 文献          | `paper-lookup` `literature-review` `peer-review` `citation-management` `bgpt-paper-search`                                                                     | 文献检索、综述、同行评审               |
| 文档 / 图表          | `docx` `pptx` `pdf` `matplotlib` `infographics` `latex-posters` `markdown-mermaid-writing`                                                                     | 科研写作与可视化                       |
| 实验室 / 平台集成    | `benchling-integration` `dnanexus-integration` `latchbio-integration` `omero-integration` `opentrons-integration` `ginkgo-cloud-lab` `protocolsio-integration` | 连接商业科研平台                       |

### 2.3 能力边界

- **覆盖领域**：生物学、化学、医学、药物发现（与描述一致）。
- **不覆盖**：软件工程、通用编程、安全、区块链等（这些恰是我们 `mipham-code` skills 的主场）。
- **强项**：把「第三方科学库的正确用法」固化成 prompt，减少 agent 的幻觉调用。

---

## 三、安全性分析（三面看）

### 3.1 做得好的

1. **MIT 许可** — 无 copyleft 污染，符合集团 CLAUDE.md「严禁 GPL」底线，可合法借鉴代码/脚本。
2. **有自动化安全扫描** — `SECURITY.md` 明确：使用 [`cisco-ai-skill-scanner`](https://pypi.org/project/cisco-ai-skill-scanner/)（静态行为分析 + trigger 分析 + LLM 辅助 review），**每个 PR 扫描、每周增量扫描、每 30 天全量重扫**，报告在 `docs/security-report.md`。
3. **有诚实的安全边界文档** — `SECURITY.md` 列出 in-scope / out-of-scope，并明确「LLM 生成的报告仅供参考，非审计保证」。

### 3.2 核心风险面（官方免责声明自认）

`SECURITY.md` 关键原文：

> "Skills execute code and influence your agent's behavior. **Review what you install**… Treat skill content from any source — including this repository — as **code review material, not as trusted input**."

三条真实风险（均在其 in-scope 列表内）：

1. **bundled scripts** — 部分 skill 带 `scripts/`，可能读取凭据 / 文件 / 环境变量、或连网传输数据。
2. **prompt injection 向量** — `references/` 或 `assets/` 里的内容会被 agent 当作「权威」读取，若混入恶意指令即为注入面。
3. **第三方 API key 依赖** — `exa-search` `database-lookup` `benchling-integration` 等大量 skill 依赖外部服务，需各自 key 且会连网。

> 按 CRSI 教训 #8（借鉴定须同时查许可 + 安全/执行边界）：**MIT 许可 ✅、有扫描 ✅，但「让 agent 执行代码」的固有风险仍在**。它不是坏项目，但装上 = 把 163 份「可信提示词」交给 agent，必须逐个 review 才能放心，不可整包盲信。

---

## 四、安装必要性 — 结论：不必要（明确判断）

理由（置信度 [高]，基于自有产品定位的已读证据）：

1. **定位不匹配** — 我们是 AI 技术公司，核心产品是编程终端（Mipham Code）、模型层、MegaSystem；该库服务的是生物医药/化学/临床科研工作者，163 个 skill 绝大多数（RDKit、Scanpy、DICOM、脑电、质谱…）与我们产品线无关。
2. **形态不互补到「必须装」** — 它提供「工具使用知识」，我们 `mipham-science` 提供「研究循环编排」（`create_project → start_loop → loop_iterate → converge`）。两者不冲突、也不互补到需要整包引入。
3. **引入成本高** — 248 MB 体量、Python 依赖、第三方 API key 配置、163 份 prompt 的安全 review 工作量，为一个当前无明确需求的能力。
4. **违反简洁优先原则** — CLAUDE.md「未要求的功能是负债」。

**唯一合理场景**：若未来 `mipham-science` 要从「编排引擎」落到「具体科研工具能力」（让 agent 真的会用 RDKit/AlphaFold 写对代码），则此库的**思想 + 按需摘取个别 skill** 有借鉴价值——但应是「抄思想 / 挑几个」，而非「全量 clone 安装」。（呼应 CRSI 教训 #14：不能把「记了该抄」当「已抄」，要落地对账。）

---

## 五、与我们系统的重复 / 类似对照

**结论：skill 层面零重复；能力层面「学科覆盖」重叠但形态不同。**（置信度 [高]）

| 对比维度         | 我们的系统                                                                  | scientific-agent-skills                   |
| ---------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| 科学类 **skill** | ❌ 无（27 个 skill 全是编程/通用类）                                        | ✅ 163 个                                 |
| 科学**能力形态** | MCP 工具：`mipham-science`（12 学科 → 研究循环编排）                        | prompt + scripts（工具用法知识）          |
| 覆盖学科         | biology/chemistry/physics/mathematics/biomedicine/quantum/security 等 12 类 | biology/chemistry/medicine/drug discovery |
| 本质             | **编排引擎**（循环、假设、收敛）                                            | **知识库**（怎么写对库代码）              |

### 5.1 自有 skill 清单（已读，confirm 无科学类）

`apps/cli/skills/` 共 27 个：

- **standard（21）**：memory、systematic-debugging、web-search、codebase-design、doc-generator、web-access、to-spec、security-review、implement、safe-coding、research、superpower、github-ops、self-review、triage、mipham-code-setup、tdd、domain-modeling、compassionate-communication、grill-with-docs、code-review —— 全部为编程/通用类。
- **mipham（6）**：save-to-wiki、om-security、om-model-optimize、self-audit、om-artifact、doc-sync —— 全部为 Mipham 专有工具类。

→ **无任何科学工具用法类 skill，skill 层面零重复。**

### 5.2 自有科学能力：mipham-science MCP 平台

12 个学科（已读 `science_list_disciplines` 返回）：
biology、chemistry、mathematics、physics、ai_security、blockchain、cryptography、encryption、information_security、biomedicine、iot、quantum_science。

每个学科下有多条 direction（如 biology 下有 `crispr_design` / `protein_design` / `synthetic_biology` / `single_cell` / `systems_biology`；chemistry 下有 `computational_chemistry` / `molecular_dynamics` / `drug_discovery` / `catalyst_design` / `spectroscopy`）。

### 5.3 具体重叠点（诚实标注）

- 我们的 `protein_design`、`drug_discovery`、`molecular_dynamics`、`single_cell` 等 direction，与它的 `rdkit`、`diffdock`、`scanpy`、`molecular-dynamics` 等 skill **面向同一批科研问题**。
- 但一个是「组织研究流程的 API」，一个是「教 agent 用工具的提示词」——**不构成重复**，反而是潜在互补：未来若要落地，可在 `mipham-science` 的研究循环里，按学科挂载对应的科学 skill 作为「工具使用知识」。

**一句话**：我们「缺」的不是这些 skill 本身，而是「如果 mipham-science 要落地具体科研工具能力，从哪补充知识」——答案可以是「从这类库按需摘取」，但当前无必要全量引入。

---

## 六、后续可做的深挖项（未做，待拍板）

1. 拉取 `docs/security-report.md`，核验它自扫出的真实风险清单（验证「安全」面的实际强度，而非只看其声明）。
2. 拉取 2–3 个与我们 `mipham-science` 重叠方向（`drug_discovery`、`protein_design`）对应的 skill 全文，做逐条「能否借鉴」的对账表。
3. 若决定借鉴，需走「许可 ✅ → 按需摘取 → 落地对账（已写代码 / 只记教训 / 仍是待办）」三态记录，避免把「记了该抄」误读为「已抄」。

---

## 附录：关键证据引用

- 仓库元数据：`https://api.github.com/search/repositories?q=scientific-agent-skills` → `K-Dense-AI/scientific-agent-skills`
- 顶层结构：`https://api.github.com/repos/K-Dense-AI/scientific-agent-skills/contents/`
- skills 目录：`.../contents/skills`（163 个子目录）
- 安全政策：`.../SECURITY.md`（引用 cisco-ai-skill-scanner + 免责声明原文）
- 自有 skills 清单：`apps/cli/skills/**`（27 个，无科学类）
- 自有科学平台：`mipham-science` MCP → `science_list_disciplines`（12 学科）
