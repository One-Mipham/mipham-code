/**
 * Mipham Code — Project Scaffold
 *
 * `mipham init` 生成规范的项目文档，避免用户「冷建立文件」。
 *
 * 分级：
 * - 基础（默认）：CLAUDE.md（简版）+ MIPHAM.md + README.md
 * - 完整（--full）：八章 CLAUDE.md + SECURITY/CONTRIBUTING/CODE_OF_CONDUCT/
 *   DEVELOPMENT/TRADEMARKS/CHANGELOG/LICENSE + .github 四件套
 *
 * 模板遵循 One Mipham Corporation 规范。
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execSync } from 'node:child_process'

export interface ScaffoldResult {
  created: string[]
  skipped: string[]
  gitInitialized: boolean
}

export type LicenseType = 'proprietary' | 'mit' | 'apache'

export interface ScaffoldOptions {
  /** 是否执行 git init（默认 false，由 CLI 传入 true） */
  gitInit?: boolean
  /** 完整脚手架（生成完整 .md 体系 + .github 模板） */
  full?: boolean
  /** 许可证类型，默认 proprietary */
  license?: LicenseType
}

const COPYRIGHT = '© 2026 One Mipham Corporation（北京华安麦逄科技有限公司）— All Rights Reserved.'

// ─────────────────────────────────────────────────────────────────────────────
// 基础模板（mipham init）
// ─────────────────────────────────────────────────────────────────────────────

export function renderMiphamMd(projectName: string): string {
  return `---
model: mipham-code
version: 1.0.0
privacy: project
language: zh-CN
---

# MIPHAM.md — ${projectName}

> 本文件定义 ${projectName} 项目中 AI 助手的交互人格和项目规范。
> 继承自 One Mipham Corporation 集团 MIPHAM.md。

---

## 项目概述

[简要描述项目目的和定位]

## 技术栈

[列出主要技术栈]

## 项目规范

- [添加项目特有的编码规则]
- [添加团队约定]

## AI 交互偏好

- 回复语言：[中文/英文]
- 代码风格：[偏好]
- 注释语言：[中文/英文]
`
}

export function renderClaudeMd(projectName: string): string {
  return `# CLAUDE.md

> 项目：${projectName}
> 版本：0.1.0
> 初始化：\`mipham init\`

## 项目概述

[简要描述项目目的和定位]

## 技术栈

[列出主要技术栈]

## 开发命令

- 构建：[\`填入 build 命令\`]
- 测试：[\`填入 test 命令\`]
- Lint：[\`填入 lint 命令\`]

## 项目规范

- [添加项目特有的编码规则]
- [添加团队约定]

## 关键约束

- 遵循上级 One Mipham Corporation CLAUDE.md 技术规范
- 提交信息遵循 Conventional Commits
- 禁止在代码、日志、配置或提交历史中硬编码凭据
`
}

export function renderReadmeMd(projectName: string): string {
  return `# ${projectName}

[一句话描述项目]

## 快速开始

\`\`\`bash
# 安装依赖 / 运行项目
\`\`\`

## 技术栈

[列出技术栈]

## 文档

- \`CLAUDE.md\` — AI 协作规范
- \`MIPHAM.md\` — AI 交互人格
- \`README.md\` — 项目说明（本文件）

## 许可

[填入许可证]
`
}

// ─────────────────────────────────────────────────────────────────────────────
// 完整模板（mipham init --full）
// ─────────────────────────────────────────────────────────────────────────────

export function renderFullClaudeMd(projectName: string): string {
  return `# CLAUDE.md

> **项目**: ${projectName}
> **版本**: 0.1.0
> **初始化**: \`mipham init --full\`
> **公司**: One Mipham Corporation | 品牌: MiphamAI
> **维护人**: One Mipham Corporation 技术委员会
> **审核周期**: 每季度复审一次

This file provides guidance to Claude Code when working with code in this repository.

---

## 一、项目概述

[简要描述项目目的和定位]

| 模块 | 目录 | 框架 | 语言 |
|------|------|------|------|
| [模块名] | \`[目录]\` | [框架] | [语言] |

## 二、AI 编码协作原则

**原则 1: 编码前先思考 — Think Before Coding**
- 不确定时必须提问，不得自行假设；存在多种解读时呈现所有选项
- 有更简单方案时必须指出；有理由时应推回不合理需求

**原则 2: 简洁优先 — Simplicity First**
- 只写解决问题所需的最小代码，不写未要求的功能
- 不添加未被要求的"灵活性"或"可配置性"

**原则 3: 精准修改 — Surgical Changes**
- 只改被要求修改的内容；匹配现有代码风格
- 发现无关 dead code 时只提出来，不自行删除

**原则 4: 目标驱动执行 — Goal-Driven Execution**
- 将任务转化为可验证的成功标准；多步骤任务先陈述简要计划

## 三、合规与安全（强制性）

- 用户数据：传输层 TLS 1.3，存储层 AES-256-GCM（母公司底线）
- 禁止在代码、日志、配置文件或提交历史中硬编码凭据、API 密钥、令牌
- PII 脱敏后进入开发/测试环境
- 面向用户的 AI 功能上线前通过 prompt injection 与对抗攻击测试

## 四、代码质量标准

- 配置自动化 lint + 格式化工具，通过 CI 强制执行
- 新代码通过测试后合并；至少一名资深工程师 review
- 禁止直接提交主分支：feature branch + PR 流程
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)

## 五、技术架构原则

- 服务间通信通过定义良好的 API，禁止跨服务直接数据库访问
- 关键业务路径可观测性：结构化日志 + 指标 + 追踪
- 基础设施即代码（IaC）

## 六、项目结构约定

\`\`\`
${projectName}/
├── CLAUDE.md               # AI 编码规范
├── SECURITY.md             # 安全策略
├── README.md               # 项目说明
├── LICENSE                 # 许可证
├── CHANGELOG.md            # 版本变更日志
├── .github/                # PR/Issue 模板 + CODEOWNERS
└── src/                    # [源代码目录]
\`\`\`

## 七、技术决策框架

按优先级评估技术选型：成熟度与社区支持 → 安全合规 → 团队能力匹配 → 技术栈互操作性 → 许可证与供应商风险。

## 八、代码评审检查清单

- [ ] 无硬编码凭据、密钥或 Token
- [ ] 敏感数据已加密/脱敏
- [ ] 新功能有对应测试
- [ ] 提交信息符合 Conventional Commits

---

### 修订历史

| 版本 | 日期 | 变更内容 | 维护人 |
|------|------|---------|--------|
| 0.1.0 | 2026-08-30 | \`mipham init --full\` 初始化 | 技术委员会 |

---

> **版权**: ${COPYRIGHT}
`
}

export function renderSecurityMd(projectName: string): string {
  return `# Security Policy — ${projectName}

## 加密要求

- 传输层 TLS 1.3，存储层 AES-256-GCM（母公司底线）
- 禁止在代码、日志、配置或提交历史中硬编码凭据、API 密钥、令牌

## 依赖安全

- 第三方依赖引入前通过许可证合规检查（严禁 copyleft/GPL）
- 定期升级依赖，响应 Dependabot 告警

## AI 安全

- 面向用户的 AI 功能上线前通过 prompt injection 测试、对抗攻击红队评估
- LLM System Prompt 版本管理，变更记录原因和审批人

## 报告漏洞

安全漏洞请勿公开提交 issue，私密报告至维护人（见 README）。
`
}

export function renderContributingMd(projectName: string, license: LicenseType): string {
  const isOpen = license !== 'proprietary'
  const header = isOpen
    ? `# Contributing to ${projectName}

感谢你对 **${projectName}** 的关注。本项目采用 **${license === 'apache' ? 'Apache 2.0' : 'MIT'}** 开源许可。
`
    : `# Contributing to ${projectName}

**${projectName} 是专有闭源商业软件**（见 LICENSE）。本文档仅面向**内部团队成员和授权贡献者**，不接受外部 PR。
`

  return `${header}
## 分支与提交

- 分支命名：\`feat/xxx\`、\`fix/xxx\`、\`docs/xxx\`、\`chore/xxx\`
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)
- \`main\` 受保护，所有变更走 PR + 至少一名资深工程师 review

## Pull Request 指南

请说明：
- 改了什么、为什么
- 如何测试
- UI 变更附截图
- 涉及环境变量或数据库迁移时，说明兼容性影响

## 安全

- 禁止硬编码凭据、密钥或 Token
- 安全漏洞按 SECURITY.md 渠道私密报告

## 许可证

${isOpen ? `贡献将被纳入项目许可证之下（见 LICENSE）。` : '未经书面授权，禁止复制、修改、分发或使用（见 LICENSE）。'}
`
}

export function renderCodeOfConductMd(projectName: string): string {
  return `# Code of Conduct — ${projectName}

## 期望行为

- 清晰、尊重地沟通
- 聚焦想法、代码与设计，而非个人
- 除非确证，否则假设他人善意
- 保持讨论相关且有建设性

## 不可接受的行为

- 任何形式的骚扰、歧视或恐吓
- 人身攻击、侮辱或贬损性言论
- 未经许可发布他人隐私信息

## 举报

如遇违反本准则的行为，通过 README.md 中的渠道联系维护者。所有举报严肃、保密处理。
`
}

export function renderDevelopmentMd(projectName: string): string {
  return `# ${projectName} — 开发指南

## 前置条件

| 工具 | 版本 | 说明 |
|------|------|------|
| [工具] | [版本] | [说明] |

## 快速开始

\`\`\`bash
# 1. 安装依赖
# 2. 配置环境
# 3. 运行
\`\`\`

## 常用命令

\`\`\`bash
# 构建 / 测试 / lint
\`\`\`

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| [变量名] | [是/否] | [说明] |

## 测试

\`\`\`bash
# 运行测试
\`\`\`
`
}

export function renderTrademarksMd(projectName: string): string {
  return `# ${projectName} 商标与品牌政策

本文件规范 **${projectName}** 商标与品牌资产的使用（名称、Logo、视觉识别）。独立于代码许可证。

> 说明：本政策仅为清晰起见，不构成法律意见。

## 允许的使用

- 讨论官方未修改项目时如实提及"${projectName}"
- 用名称链接到本仓库

## 禁止的使用（未经书面许可）

- 以暗示背书、赞助或官方身份的方式使用商标
- 修改、重绘、裁剪 Logo 或衍生品牌资产
- 注册或使用易混淆的名称 / 域名 / 社交账号

## 商业许可与授权

如需白标、OEM、企业部署，联系：\`legal@onemipham.com\`
`
}

export function renderChangelogMd(projectName: string): string {
  return `# Changelog

All notable changes to ${projectName} will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-08-30

### Added
- 初始版本（\`mipham init --full\` 脚手架）
`
}

export function renderLicenseMd(license: LicenseType): string {
  if (license === 'mit') {
    return `MIT License

Copyright (c) 2026 One Mipham Corporation（北京华安麦逄科技有限公司）

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
  }
  if (license === 'apache') {
    return `Apache License 2.0

Copyright (c) 2026 One Mipham Corporation（北京华安麦逄科技有限公司）

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at:

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
`
  }
  return `${projectLicenseProprietary()}
`
}

function projectLicenseProprietary(): string {
  return `Copyright (c) 2026 One Mipham Corporation（北京华安麦逄科技有限公司）
All rights reserved.

Proprietary Software — Closed Source Commercial Software

This software and its source code are the proprietary property of
One Mipham Corporation. Reproduction, modification, distribution,
or use of this software in any form is prohibited without explicit
written authorization.
`
}

export function renderPullRequestTemplate(): string {
  return `## 变更说明
<!-- 改了什么、为什么 -->

## 变更类型
- [ ] feat 新功能
- [ ] fix 修复
- [ ] docs 文档
- [ ] chore 维护

## 如何测试
<!-- 验证步骤与命令 -->

## 截图
<!-- UI 变更附截图 -->

## 兼容性影响
<!-- 环境变量、数据库迁移或破坏性变更 -->
`
}

export function renderBugReportTemplate(): string {
  return `---
name: Bug 报告
about: 报告一个 bug
title: "[Bug] "
labels: bug
assignees: ""
---

## 描述
<!-- 清晰描述 bug -->

## 复现步骤
1.
2.
3.

## 期望行为

## 实际行为

## 环境
- 平台 / 系统：
- 版本：
- 日志 / 截图：
`
}

export function renderFeatureRequestTemplate(): string {
  return `---
name: 功能请求
about: 建议一个新功能
title: "[Feature] "
labels: enhancement
assignees: ""
---

## 问题背景
<!-- 这个功能解决什么问题 -->

## 期望方案
<!-- 描述你期望的功能 -->

## 备选方案
<!-- 考虑过的其他方案 -->
`
}

export function renderCodeowners(owner: string): string {
  return `* @${owner.replace(/^@/, '')}
`
}

// ─────────────────────────────────────────────────────────────────────────────
// 脚手架
// ─────────────────────────────────────────────────────────────────────────────

/** 检测目录是否为「愣建文件夹」——无任何条目（忽略 .DS_Store）。目录不存在则视为非空。 */
export function isEmptyProject(dir: string): boolean {
  try {
    const entries = readdirSync(dir).filter((e) => e !== '.DS_Store')
    return entries.length === 0
  } catch {
    return false
  }
}

interface FileSpec {
  path: string
  content: string
}

function buildFileSpecs(name: string, opts?: ScaffoldOptions): FileSpec[] {
  const full = opts?.full === true
  const license: LicenseType = opts?.license ?? 'proprietary'

  const specs: FileSpec[] = [
    { path: 'CLAUDE.md', content: full ? renderFullClaudeMd(name) : renderClaudeMd(name) },
    { path: 'MIPHAM.md', content: renderMiphamMd(name) },
    { path: 'README.md', content: renderReadmeMd(name) },
  ]

  if (!full) return specs

  return [
    ...specs,
    { path: 'SECURITY.md', content: renderSecurityMd(name) },
    { path: 'CONTRIBUTING.md', content: renderContributingMd(name, license) },
    { path: 'CODE_OF_CONDUCT.md', content: renderCodeOfConductMd(name) },
    { path: 'DEVELOPMENT.md', content: renderDevelopmentMd(name) },
    { path: 'TRADEMARKS.md', content: renderTrademarksMd(name) },
    { path: 'CHANGELOG.md', content: renderChangelogMd(name) },
    { path: 'LICENSE', content: renderLicenseMd(license) },
    { path: '.github/pull_request_template.md', content: renderPullRequestTemplate() },
    { path: '.github/ISSUE_TEMPLATE/bug_report.md', content: renderBugReportTemplate() },
    { path: '.github/ISSUE_TEMPLATE/feature_request.md', content: renderFeatureRequestTemplate() },
    { path: '.github/CODEOWNERS', content: renderCodeowners('sarvadaya') },
  ]
}

export function scaffoldProject(targetDir: string, opts?: ScaffoldOptions): ScaffoldResult {
  mkdirSync(targetDir, { recursive: true })

  const name = basename(targetDir) || 'my-project'
  const files = buildFileSpecs(name, opts)

  const created: string[] = []
  const skipped: string[] = []

  for (const f of files) {
    const full = join(targetDir, f.path)
    if (existsSync(full)) {
      skipped.push(f.path)
    } else {
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, f.content, 'utf-8')
      created.push(f.path)
    }
  }

  let gitInitialized = false
  if (opts?.gitInit && !existsSync(join(targetDir, '.git'))) {
    try {
      execSync('git init', { cwd: targetDir, stdio: 'ignore' })
      gitInitialized = true
    } catch {
      // git 不可用或失败 — 不阻断脚手架
    }
  }

  return { created, skipped, gitInitialized }
}
