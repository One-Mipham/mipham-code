# Mipham Code — 产品设计与技术架构规格书

> **版本**: 1.0.0
> **日期**: 2026-05-31
> **作者**: Zhang Guohua & Team members - One Mipham Corporation
> **实体**: One Mipham Corporation (Delaware, USA)
> **官网**: mipham.ai
> **状态**: 已定稿，待进入实施规划

---

## 目录

1. [产品定位与品牌架构](#1-产品定位与品牌架构)
2. [开源策略：Open Core](#2-开源策略-open-core)
3. [整体技术架构](#3-整体技术架构)
4. [L1：多模型连接引擎](#4-l1多模型连接引擎)
5. [L2：CLI 核心工具系统](#5-l2cli-核心工具系统)
6. [L3：Plugin/Skills 双轨体系](#6-l3pluginskills-双轨体系)
7. [Web 管理界面](#7-web-管理界面)
8. [MIPHAM.md 指令体系](#8-mipham-md-指令体系)
9. [语言与国际化设计](#9-语言与国际化设计)
10. [Phase 1 / Phase 2 路线图](#10-phase-1--phase-2-路线图)
11. [项目结构](#11-项目结构)
12. [分发与部署策略](#12-分发与部署策略)
13. [技术栈总览](#13-技术栈总览)

---

## 1. 产品定位与品牌架构

### 1.1 一句话定位

> **Mipham Code** — 连接全球大模型的开放智能编程终端。
> Phase 1 做最好的多模型连接器，Phase 2 做最懂自研模型的开发伙伴。

### 1.2 竞争格局定位

```
          闭源                         开源
          ┌──────────────┬──────────────┐
    单模型 │  Claude Code  │              │
          │  (Anthropic)  │              │
          ├──────────────┼──────────────┤
    多模型 │              │ ★ Mipham Code │
          │              │  Codex CLI   │
          │              │  Gemini CLI  │
          └──────────────┴──────────────┘

Mipham Code = 唯一的多模型 + Open Core 产品
```

### 1.3 品牌呈现（mipham.ai）

```
mipham.ai 首页 → Products 导航 → Mipham Code 独立页面
                                  ├── 产品介绍 (What & Why)
                                  ├── 功能特性 (Features)
                                  ├── 下载安装 (Get Started)
                                  ├── 文档中心 (Documentation)
                                  └── 订阅管理 (Pricing & Dashboard)
```

### 1.4 竞品对比

| | Mipham Code | Claude Code | Codex CLI | Gemini CLI |
|------|------|------|------|------|
| 开源策略 | Open Core | 闭源 | Apache 2.0 | Apache 2.0 |
| 模型支持 | **多模型** | 仅 Claude | 仅 OpenAI | 仅 Gemini |
| 上下文 | 模型决定 | 200K-1M | ~192K | 1M |
| 扩展方式 | SKILL.md + MCP | Hook + MCP | SKILL.md | SKILL.md |
| 自研模型 | Phase 2: om-V5 系列 | ❌ | ❌ | ❌ |
| 分发 | npm + 二进制 | npm | npm + 二进制 | npm + 二进制 |
| 交互形态 | CLI + Web | CLI + Web | CLI | CLI |

---

## 2. 开源策略：Open Core

```
┌─────────────────────────────────────────────┐
│           PROPRIETARY (商业层)               │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐ │
│  │ 自研模型  │  │ 企业管理  │  │ 云托管服务  │ │
│  │ omGPT等  │  │ SSO/审计  │  │ MCP 托管   │ │
│  └─────────┘  └──────────┘  └────────────┘ │
├─────────────────────────────────────────────┤
│           OPEN SOURCE (Apache 2.0)           │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐ │
│  │ CLI 引擎 │  │ 多模型连接│  │ Plugin/Skill│ │
│  │ 核心框架  │  │ 统一接口  │  │ 社区生态    │ │
│  └─────────┘  └──────────┘  └────────────┘ │
└─────────────────────────────────────────────┘
```

**License**: Apache 2.0（核心层）/ 商业许可（企业层）

---

## 3. 整体技术架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Mipham Code Architecture                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    USER INTERFACE LAYER                      │ │
│  │  ┌─────────────────────┐    ┌─────────────────────────────┐│ │
│  │  │   CLI (Bun + Ink)   │    │   Web (mipham.ai/code)      ││ │
│  │  │   • 交互式会话       │    │   • 产品展示/文档/下载       ││ │
│  │  │   • React TUI 渲染   │    │   • 订阅管理/API Key/用量   ││ │
│  │  │   • Slash Commands  │    │   • 会话历史                 ││ │
│  │  └─────────┬───────────┘    └──────────────┬──────────────┘│ │
│  └────────────┼──────────────────────────────┼────────────────┘ │
│               │                              │                    │
│  ┌────────────┴──────────────────────────────┴────────────────┐ │
│  │                    ORCHESTRATION LAYER                       │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐ │ │
│  │  │ Agent    │ │ Task     │ │ Plan     │ │ Permission    │ │ │
│  │  │ Manager  │ │ Scheduler│ │ Mode     │ │ System        │ │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────────┘ │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │ │
│  │  │ Context  │ │ Memory   │ │ Hooks    │ │ Instructions │ │ │
│  │  │ Compactor│ │ Manager  │ │ Engine   │ │ Loader       │ │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘ │ │
│  └──────────────────────────────────────────────────────────────┘ │
│               │                                                    │
│  ┌────────────┴──────────────────────────────────────────────┐    │
│  │                    PROVIDER ROUTING LAYER                   │    │
│  │  ┌──────────────────────┐  ┌──────────────────────┐       │    │
│  │  │  OpenAI-Compatible   │  │  Anthropic-Compatible │       │    │
│  │  │  Router              │  │  Router                │       │    │
│  │  │  /v1/chat/*          │  │  /v1/messages          │       │    │
│  │  └──────────┬───────────┘  └──────────┬─────────────┘     │    │
│  │             │                          │                    │    │
│  │  ┌──────────┴──────────────────────────┴───────────────┐  │    │
│  │  │  DeepSeek  Qwen  ChatGPT  Groq  Claude  Gemini ...  │  │    │
│  │  └─────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────┘    │
│               │                                                    │
│  ┌────────────┴──────────────────────────────────────────────┐    │
│  │                    EXTENSION LAYER                          │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐ │    │
│  │  │ MCP      │  │ Skills   │  │ Plugins  │  │ Hooks     │ │    │
│  │  │ Client   │  │ (双轨制) │  │ Registry │  │ System    │ │    │
│  │  └──────────┘  └──────────┘  └──────────┘  └───────────┘ │    │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 4. L1：多模型连接引擎

### 4.1 协议路由策略

**OpenAI 兼容路由 + Anthropic 兼容路由作为双主干**，非标准协议模型单独适配。

```
用户请求
    │
    ├── OpenAI-Compatible Router (/v1/chat/*)
    │   → ChatGPT, DeepSeek, Qwen, Groq, 通义千问...
    │   → 任何兼容 OpenAI API 的提供商 (50+) 零适配接入
    │
    ├── Anthropic-Compatible Router (/v1/messages)
    │   → Claude Opus 4.8, Sonnet 4.6, Haiku 4.5
    │   → 任何兼容 Anthropic API 的提供商
    │
    └── Custom Adapters
        → Gemini (Google 专用协议)
        → 未来扩展
```

### 4.2 核心接口

```typescript
interface ModelProvider {
  id: string
  protocol: 'openai-compatible' | 'anthropic' | 'custom'
  chat(req: ChatRequest): AsyncIterator<StreamChunk>
  listModels(): Promise<ModelInfo[]>
  countTokens(messages: Message[]): number
  healthCheck(): Promise<boolean>
}
```

### 4.3 模型配置

```yaml
providers:
  # ──── One Mipham Corporation — 自研模型 (Phase 2) ────
  - id: mipham
    name: MiphamAI
    protocol: openai-compatible
    baseUrl: https://api.mipham.ai/v1    # 预留
    apiKey: ${MIPHAM_API_KEY}
    models:
      - om-v5-pro          # 旗舰：推理与程序开发大模型
      - om-v5-flash        # 轻量：低延迟高吞吐，边缘部署
      - om-v5-image        # 视觉：图像理解、生成、多模态
    status: upcoming       # Phase 2 激活

  # ──── Anthropic ────
  - id: anthropic
    name: Anthropic Claude
    protocol: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    models:
      - claude-opus-4-8           # 旗舰：复杂推理/长程编码
      - claude-sonnet-4-6          # 主力：性价比最优
      - claude-haiku-4-5-20251001  # 轻量：高频简单任务

  # ──── OpenAI ────
  - id: openai
    name: OpenAI
    protocol: openai-compatible
    baseUrl: https://api.openai.com/v1
    apiKey: ${OPENAI_API_KEY}
    models:
      - gpt-5.5           # 旗舰：1M 上下文，最强通用
      - gpt-5.4           # 主力：高性价比前沿模型
      - gpt-5.4-mini      # 轻量：高并发/低成本
      - gpt-5.3-codex     # 专项：编程优化

  # ──── DeepSeek ────
  - id: deepseek
    name: DeepSeek
    protocol: openai-compatible
    baseUrl: https://api.deepseek.com/v1
    apiKey: ${DEEPSEEK_API_KEY}
    models:
      - deepseek-v4-pro       # 旗舰：49B active，1M 上下文
      - deepseek-v4-flash     # 轻量：13B active，极致性价比

  # ──── 通义千问 ────
  - id: qwen
    name: 通义千问
    protocol: openai-compatible
    baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1
    apiKey: ${QWEN_API_KEY}
    models:
      - qwen-plus
      - qwen-max
```

---

## 5. L2：CLI 核心工具系统

Phase 1 内置 **16 个核心工具**，覆盖 80% 日常开发场景。

### 5.1 工具清单

| 分类 | 工具 | 功能 |
|------|------|------|
| **File** | Read | 读取文件内容 |
| | Write | 写入/覆盖文件 |
| | Edit | 精确字符串替换 |
| | Glob | 文件模式搜索 |
| | Grep | 内容正则搜索 |
| **Execution** | Bash | Shell 命令执行 |
| | Git | Git 操作 |
| | Task | 任务创建/管理 |
| **AI & Agent** | Agent | 子代理生成 |
| | Skill | 技能调用 |
| | Plan | 规划模式（只读分析） |
| | Memory | 记忆读写管理 |
| **Network** | WebFetch | 网页内容抓取 |
| | WebSearch | 网络搜索 |
| **System** | Config | 配置读写 |
| | MCP | MCP Client 协议 |

### 5.2 并发调度

- **只读工具**（Read, Glob, Grep, WebFetch, WebSearch）：并行执行
- **写入工具**（Write, Edit, Bash, Git）：串行执行

### 5.3 权限系统

```
auto   — 智能分析：安全命令自动执行
ask    — 确认模式：所有写入操作需确认
bypass — 跳过模式：完全信任（仅限沙盒）
```

---

## 6. L3：Plugin/Skills 双轨体系

### 6.1 架构

```
┌───────────────────────────────────────────────────────┐
│  🚀 Mipham 独家 Skills (.mipham-skill.md)              │
│                                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ om-Model │ │ om-Self  │ │ om-Audit │ │ om-Deploy│ │
│  │ Optimize │ │ Review   │ │ Security │ │ Pipeline │ │
│  │ 模型择优  │ │ 自我审查  │ │ 安全审计  │ │ 部署流水线│ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
│                                                        │
│  独家能力：多模型协同编排 · 自研模型深度调优 · 企业治理   │
├───────────────────────────────────────────────────────┤
│  📦 标准 SKILL.md 兼容层（社区生态零成本接入）            │
│                                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │superpower│ │ self-    │ │ code-    │ │ web-     │ │
│  │ brainstorm│ │ review   │ │ review   │ │ search   │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ memory   │ │ tdd      │ │ github-  │ │ doc-     │ │
│  │          │ │ guide    │ │ ops      │ │ generator│ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
│                                                        │
│  来自社区生态，开箱即用                                    │
└───────────────────────────────────────────────────────┘

🔌 MCP Client — 兼容 300+ 外部服务 (数据库、API、工具)
```

### 6.2 Phase 1 内置 Skills（10 个）

| Skill | 来源 | 用途 |
|------|------|------|
| `superpower` | 社区兼容 | 技能调用框架 |
| `code-review` | 社区兼容 | 代码审查 |
| `self-review` | 社区兼容 | 自我审查 |
| `memory` | 社区兼容 | 记忆管理 |
| `tdd` | 社区兼容 | 测试驱动开发 |
| `web-search` | 社区兼容 | 网络搜索 |
| `github-ops` | 社区兼容 | GitHub 操作 |
| `doc-generator` | 社区兼容 | 文档生成 |
| `om-model-optimize` | Mipham 独家 | 多模型智能择优路由 |
| `om-security` | Mipham 独家 | 安全审计钩子 |

---

## 7. Web 管理界面

### 7.1 技术实现

| 维度 | 决策 |
|------|------|
| 框架 | Next.js 14+ App Router + Tailwind CSS |
| 部署 | omc-project00 monorepo 中的 `apps/mipham.ai`，路由 `/code`（mipham.ai 为国际英文站） |
| 语言 | 单语言英语（国际站） |
| 文档 | MDX 驱动，存放在 `content/code/docs/` |
| 订阅 | Phase 1 预留 Stripe 接口，先做免费 Beta 注册 |

### 7.2 页面结构

```
mipham.ai/code
├── /              → 产品首页：定位 + 功能 + 下载
├── /docs          → 文档中心 (MDX)
├── /dashboard     → 订阅管理：API Key、用量、账单
└── /install       → 安装指南（macOS / Linux / Windows）
```

---

## 8. MIPHAM.md 指令体系

### 8.1 两级 + 用户架构

```
┌─────────────────────────────────────────────────────────────┐
│  Tier 1: 集团级 (One Mipham Corporation, Delaware USA)       │
│  ~/One_Mipham_Corporation/CLAUDE.md                         │
│  → 全子公司统一的技术栈标准、AI安全、编码原则                   │
│  → 语言: zh-CN · 隐私: project（进入仓库）                   │
│                                                              │
│  Tier 2: 项目级                                             │
│  ~/One_Mipham_Corporation/omc-project9-MiphamCode/           │
│      MIPHAM.md                                              │
│  → Mipham Code 自身的架构定义、开发规则                        │
│  → 语言: zh-CN · 隐私: project                              │
│  → 递归发现子目录中的 MIPHAM.md（目录级覆盖）                  │
│                                                              │
│  Tier 3: 用户级                                             │
│  ~/.mipham/USER.md                                          │
│  → 个人编码偏好、全局指令                                     │
│  → 语言: zh-CN · 隐私: private（不进入仓库）                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 上下文注入流程

```
Session Start
     │
     ├── 1. 加载 ~/One_Mipham_Corporation/CLAUDE.md       (集团底线)
     ├── 2. 加载 项目 MIPHAM.md                              (项目规则)
     ├── 3. 递归加载 子目录 MIPHAM.md                         (目录级覆盖)
     ├── 4. 加载 ~/.mipham/USER.md                           (个人偏好)
     ├── 5. 加载 ~/.mipham/memory/                           (持久记忆)
     └── 注入到当前选中模型的 System Prompt（不绑定供应商）
```

### 8.3 MIPHAM.md 模板

```markdown
---
model: mipham-code
version: 1.0.0
privacy: project
language: zh-CN
model-hints:                                   # Phase 2 自研模型专属
  om-v5-pro: { temperature: 0.3, effort: high }
  om-v5-flash: { temperature: 0.7 }
---

# MIPHAM.md — Mipham Code

> 本项目规范，所有连接的模型均需遵守。

## 技术栈
- 运行时: Bun + TypeScript strict
- ...

## 编码规则
- 提交信息遵循 Conventional Commits
- ...
```

### 8.4 MIPHAM.md vs CLAUDE.md 差异化

| | CLAUDE.md (Claude Code) | MIPHAM.md (Mipham Code) |
|------|------|------|
| 作用域 | Claude 专属 | 所有模型通用 — 不绑定供应商 |
| 模型路由 | 仅注入 Anthropic API | 统一注入到任何选中的模型 |
| 隐私级别 | 无分层 | `public` / `project` / `private` |
| 自研模型 | 不适用 | om 系列预留 `model-hints` 字段 |
| 语言设定 | 环境变量间接决定 | MIPHAM.md 显式 `language` 字段 |

---

## 9. 语言与国际化设计

### 9.1 两层语言分离

```
项目上下文语言（MIPHAM.md: language: zh-CN）
  → 告知 AI：项目注释/文档是中文
  → 不影响 CLI 界面显示

CLI 界面语言（用户侧独立检测）
  → 根据用户 OS 环境自动选择
  → 与国际用户的系统语言一致
```

### 9.2 CLI 界面语言检测优先级

```
🥇 1st:  CLI 参数    → mipham --lang en
🥈 2nd:  USER.md     → ~/.mipham/USER.md: language: en
🥉 3rd:  环境变量    → LANG=en_US.UTF-8 / LC_ALL
🏅 4th:  OS 系统语言 → 从操作系统读取
🏁 Fallback: en-US
```

### 9.3 与 Claude Code 的关键区别

Claude Code 无内置 i18n，CLI 界面硬编码英文。Mipham Code 从设计之初将语言作为一等公民。

---

## 10. Phase 1 / Phase 2 路线图

```
Phase 1 (2026 Q3-Q4) — 大模型连接套件          Phase 2 (2027+) — 自研模型深度集成
═══════════════════════════════════════        ═══════════════════════════════════

  ✅ 多模型连接引擎                                 ✅ 自研模型接入 (om-V5 系列)
     • OpenAI 兼容路由                                 • om-v5-pro 推理引擎
     • Anthropic 兼容路由                              • om-v5-flash 本地推理
     • Gemini 适配                                     • om-v5-image 多模态交互

  ✅ CLI + Web 双界面                               ✅ IDE 插件体系
     • Bun + Ink CLI                                   • VS Code 插件
     • mipham.ai/code Web                              • JetBrains 插件

  ✅ 16 核心工具 + MCP                             ✅ 企业级功能
     • File / Bash / Agent / Web...                    • SSO / SAML
     • MCP Client 兼容 300+ 服务                       • 审计日志 / 合规报告

  ✅ Skills 双轨体系                                ✅ 云托管服务
     • 标准 SKILL.md 兼容                              • MCP 服务托管
     • 10 内置 Skills                                  • 团队协作空间
     • Mipham 独家扩展                                 • 私有部署

  ✅ 双通道分发                                      ✅ 性能与规模
     • npm install -g mipham-code                      • Rust 代码搜索引擎
     • 官网二进制下载                                   • 本地模型推理加速
```

### 10.1 Phase 1 里程碑

| 里程碑 | 内容 | 可验证成果 |
|------|------|------|
| **M1 — CLI 原型** | CLI 框架 + 模型连接 + 基础工具 | 可交互对话、读写文件 |
| **M2 — 工具系统** | 16 工具 + MCP + Permission + Hooks | 完整开发工作流闭环 |
| **M3 — Skills** | 双轨体系 + 10 内置 Skills | 社区 SKILL.md 可加载 |
| **M4 — Web** | mipham.ai/code 上线 | 产品页 + 文档 + 下载 |
| **M5 — Beta** | 内测发布 | 100 用户内测，收集反馈 |
| **M6 — GA** | 正式发布 | npm + 官网公开发布 |

---

## 11. 项目结构

```
omc-project9-MiphamCode/
├── MIPHAM.md                     # 项目级指令 (Tier 2)
├── SECURITY.md                   # 安全策略
├── CODE_OF_CONDUCT.md            # 社区行为准则
├── CONTRIBUTING.md               # 贡献指南
├── LICENSE                       # Apache 2.0
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
│
├── apps/
│   ├── cli/                      # CLI 核心 (Bun + TypeScript)
│   │   ├── src/
│   │   │   ├── core/             # 核心引擎
│   │   │   │   ├── engine.ts     # 查询引擎 (请求→模型→工具→响应)
│   │   │   │   ├── context.ts    # 上下文管理器 (压缩/缓存/窗口)
│   │   │   │   ├── permission.ts # 权限系统 (auto/ask/bypass)
│   │   │   │   ├── hooks.ts      # Hook 引擎 (PreToolUse/PostToolUse/Session)
│   │   │   │   └── instructions.ts # MIPHAM.md 加载引擎
│   │   │   ├── providers/        # 多模型连接层
│   │   │   │   ├── registry.ts   # Provider 注册表
│   │   │   │   ├── openai-compat.ts
│   │   │   │   ├── anthropic.ts
│   │   │   │   └── custom/       # Gemini 等单独适配
│   │   │   ├── tools/            # 内置工具 (16个)
│   │   │   │   ├── file/         # Read, Write, Edit, Glob, Grep
│   │   │   │   ├── exec/         # Bash, Git, Task
│   │   │   │   ├── agent/        # Agent, Skill, Plan, Memory
│   │   │   │   ├── network/      # WebFetch, WebSearch
│   │   │   │   └── system/       # Config, MCP
│   │   │   ├── skills/           # Skills 双轨引擎
│   │   │   │   ├── loader.ts     # SKILL.md 解析 + 加载
│   │   │   │   ├── standard/     # 标准 SKILL.md 运行时
│   │   │   │   └── mipham/       # Mipham 独家扩展运行时
│   │   │   ├── mcp/              # MCP Client
│   │   │   ├── ui/               # CLI UI (Ink/React)
│   │   │   │   ├── app.tsx       # 主界面
│   │   │   │   ├── chat.tsx      # 对话面板
│   │   │   │   └── components/   # 终端组件
│   │   │   └── config/           # 配置管理 (.mipham/)
│   │   ├── skills/               # 内置 Skills 定义
│   │   │   ├── standard/         # 标准 SKILL.md (8个)
│   │   │   └── mipham/           # Mipham 独家 (2个)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/                      # Web 界面 (Next.js)
│       └── src/app/code/         # mipham.ai/code 路由
│           ├── page.tsx          # 产品首页
│           ├── docs/             # 文档中心
│           ├── dashboard/        # 订阅管理
│           └── components/
│
├── packages/
│   └── shared/                   # 共享类型/常量
│       ├── src/
│       │   ├── types.ts          # Provider, Tool, Skill 类型定义
│       │   └── constants.ts      # 模型列表、配置键
│       └── package.json
│
└── docs/                         # 设计文档
    └── superpowers/
        └── specs/
            └── 2026-05-31-mipham-code-design.md
```

---

## 12. 分发与部署策略

### 12.1 双通道分发

| 通道 | 命令 | 目标用户 |
|------|------|------|
| npm | `npm install -g mipham-code` | 开发者 / CI/CD |
| 官网二进制 | `curl -fsSL mipham.ai/code/install.sh \| sh` | 普通用户 / 无 Node 环境 |

### 12.2 Bun `--compile` 构建矩阵

| 平台 | 架构 | 格式 |
|------|------|------|
| macOS | arm64 / x64 | 单文件二进制 |
| Linux | x64 / arm64 | 单文件二进制 |
| Windows | x64 | 单文件 .exe |

一套 TypeScript 源码，`bun build --compile` 生成多平台独立二进制。无需 Node.js/Bun 运行时。

---

## 13. 技术栈总览

| 组件 | 技术 | 说明 |
|------|------|------|
| CLI 运行时 | Bun 1.2+ | 单文件编译，接近 Rust 冷启动 |
| CLI 语言 | TypeScript strict | 全栈类型安全 |
| CLI UI | React 18 + Ink 5 | 终端富交互渲染 |
| Web 框架 | Next.js 14+ App Router | 与 omc-project0 同栈 |
| 样式 | Tailwind CSS | 与官网统一设计语言 |
| 包管理 | pnpm | monorepo workspace |
| 代码搜索 | ripgrep (Rust) | 极致性能 |
| 模型 SDK | Anthropic SDK + OpenAI SDK | 原生协议兼容 |
| 流式处理 | AsyncIterator | 统一流式响应抽象 |
| 测试 | Vitest (CLI) | Bun 原生兼容 |
| Lint | ESLint + Prettier | CI 强制执行 |
| CI/CD | GitHub Actions | 多平台构建矩阵 |
| 分发 | npm registry + 官网 CDN | 双通道 |

---

## 附录：设计决策记录

| # | 决策 | 选项 | 结论 |
|------|------|------|------|
| 1 | 交互形态 | CLI / CLI+Web / CLI+Web+IDE | **CLI + Web 双界面** |
| 2 | 开源策略 | 闭源 / Open Core / 完全开源 | **Open Core** (Apache 2.0) |
| 3 | 技术栈 | TS+Bun / Rust / Go | **TypeScript + Bun 为主，Rust 辅助** |
| 4 | Skills 体系 | 纯兼容 / 纯自建 / 双轨 | **双轨制**：SKILL.md 兼容 + Mipham 独家 |
| 5 | 模型连接 | 适配器模式 / 协议翻译 | **协议翻译层**：OpenAI + Anthropic 双路由 |
| 6 | 分发策略 | npm / 二进制 / 双通道 | **双通道**：npm + 官网二进制 |
| 7 | 指令体系 | 三级 CLAUDE.md / 两级 MIPHAM.md | **两级 + 用户**：集团 CLAUDE.md + 项目 MIPHAM.md + 用户 USER.md |
| 8 | 语言设定 | 统一 / 分离 | **项目语言与 CLI 界面语言分离** |

---

> **下一步**: 进入实施规划阶段（`writing-plans` skill），将本设计文档转化为可执行的开发计划。
