/**
 * Mipham Code — Project Scaffold
 *
 * `mipham init` 生成规范的项目文档（CLAUDE.md + MIPHAM.md + README.md），
 * 避免用户「冷建立文件」。模板遵循 One Mipham Corporation 规范。
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execSync } from 'node:child_process'

export interface ScaffoldResult {
  created: string[]
  skipped: string[]
  gitInitialized: boolean
}

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

/** 检测目录是否为「愣建文件夹」——无任何条目（忽略 .DS_Store）。目录不存在则视为非空。 */
export function isEmptyProject(dir: string): boolean {
  try {
    const entries = readdirSync(dir).filter((e) => e !== '.DS_Store')
    return entries.length === 0
  } catch {
    return false
  }
}

export function scaffoldProject(targetDir: string, opts?: { gitInit?: boolean }): ScaffoldResult {
  mkdirSync(targetDir, { recursive: true })

  const name = basename(targetDir) || 'my-project'
  const files = [
    { path: 'CLAUDE.md', content: renderClaudeMd(name) },
    { path: 'MIPHAM.md', content: renderMiphamMd(name) },
    { path: 'README.md', content: renderReadmeMd(name) },
  ]

  const created: string[] = []
  const skipped: string[] = []

  for (const f of files) {
    const full = join(targetDir, f.path)
    if (existsSync(full)) {
      skipped.push(f.path)
    } else {
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
