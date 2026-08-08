/**
 * Mipham Code — Project Setup & Security Slash Commands
 *
 * Extracted from ui/commands.ts (2026-08-06) to reduce file size.
 * Handlers for: /init, /setup, /recommend, /permissions, /add-dir,
 * /security, /audit, /prompt-audit
 */
import type { CommandHandler, CommandContext, CommandResult } from '../ui/commands.js'
import { getWorkspaceTrust } from '../core/workspace-trust'

export {
  initCmd,
  permissionsCmd,
  recommendCmd,
  setupCmd,
  addDirCmd,
  promptAuditCmd,
  securityCmd,
  trustCmd,
}

const initCmd: CommandHandler = async (ctx) => {
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const home = homedir()
  const userConfigPath = join(home, '.mipham', 'config.yml')

  // Generate user-friendly config if it doesn't exist yet
  if (!existsSync(userConfigPath)) {
    mkdirSync(join(home, '.mipham'), { recursive: true })

    const activeProviders = ctx.config.providers.filter((p) => p.status === 'active')
    const providerYaml = activeProviders
      .map((p) => {
        const tips: Record<string, string> = {
          anthropic: '# Get key: https://console.anthropic.com/',
          openai: '# Get key: https://platform.openai.com/api-keys',
          deepseek: '# Get key: https://platform.deepseek.com/api_keys',
          kimi: '# Get key: https://platform.moonshot.cn/',
          doubao: '# Get key: https://console.volcengine.com/ark',
          hunyuan: '# Get key: https://console.cloud.tencent.com/hunyuan',
          qwen: '# Get key: https://dashscope.console.aliyun.com/apiKey',
          google: '# Get key: https://aistudio.google.com/apikey',
        }
        const comment = tips[p.id] || ''
        const baseUrlLine = p.baseUrl ? `\n    baseUrl: "${p.baseUrl}"` : ''
        return `  ${comment}
  - id: ${p.id}
    name: "${p.name}"${baseUrlLine}
    apiKey: "\${${p.id.toUpperCase()}_API_KEY}"`
      })
      .join('\n\n')

    const configContent = `# Mipham Code — User Configuration
# Location: ~/.mipham/config.yml
# Docs:     https://mipham.ai/code/docs/config
#
# ═══ Quick Start ═══
# 1. Replace the API key placeholders below with your real keys
# 2. Save the file
# 3. Run 'mipham' — it auto-detects configured providers
#
# ═══ Environment Variables (Alternative) ═══
# Instead of editing this file, you can set env vars:
#   export ANTHROPIC_API_KEY="sk-ant-..."
#   export OPENAI_API_KEY="sk-..."
#   (The \${VAR} syntax below reads from environment variables)

# ── Defaults ──
defaultProvider: ${ctx.providerId}
defaultModel: ${ctx.modelId}
permission: ask

# ── Providers (${activeProviders.length} pre-configured — just add your API keys) ──
providers:
${providerYaml}
`

    writeFileSync(userConfigPath, configContent, 'utf-8')
    return {
      content: `✅ Mipham Code initialized!

Created: ~/.mipham/config.yml (${activeProviders.length} providers pre-configured)

Next steps:
  1. Edit ~/.mipham/config.yml — replace API key placeholders with your real keys
  2. Run mipham to start

Providers configured:
${activeProviders.map((p) => `  • ${p.name} — ${p.id.toUpperCase()}_API_KEY`).join('\n')}

Tip: /setup for the full 6-step wizard.`,
    }
  }

  // Config already exists — show status
  return {
    content: `~/.mipham/config.yml already exists.

Run /setup for the full wizard, or /config to view current settings.`,
  }
}

const permissionsCmd: CommandHandler = (ctx) => {
  const c = ctx.engine.getContext()
  const msgs = c.getMessages()

  return {
    content: `─ Permission Settings ─

Mode:       ${ctx.config.permission}
Messages:   ${msgs.length} in context
Tools:      ${ctx.engine.getTools().size} available

Permission levels:
  auto    — run tools automatically without asking
  ask     — prompt before each tool execution (default)
  bypass  — skip all permission checks (use with caution)

Change with /config permission <level>.

Current directory permissions:
  CWD:      ${process.cwd()}

To add a directory: use /add-dir (coming soon).
Tool execution is sandboxed to the project directory by default.`,
  }
}

const recommendCmd: CommandHandler = async (ctx) => {
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { getAvailableSkills } = await import('../skills/registry')

  const cwd = process.cwd()
  const lines: string[] = ['── Mipham Code: Setup Recommendations ──', '', `Project: ${cwd}`, '']

  // ── Detect project type ──
  const hasPackageJson = existsSync(join(cwd, 'package.json'))
  const hasTsConfig = existsSync(join(cwd, 'tsconfig.json'))
  const hasPyProject = existsSync(join(cwd, 'pyproject.toml'))
  const hasRequirements = existsSync(join(cwd, 'requirements.txt'))
  const hasDockerfile = existsSync(join(cwd, 'Dockerfile'))
  const hasGitHubActions = existsSync(join(cwd, '.github', 'workflows'))
  const hasTailwind =
    existsSync(join(cwd, 'tailwind.config.ts')) || existsSync(join(cwd, 'tailwind.config.js'))

  let pkgData: Record<string, unknown> = {}
  if (hasPackageJson) {
    try {
      pkgData = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'))
    } catch {
      /* ignore */
    }
  }
  const deps = {
    ...((pkgData.dependencies as Record<string, string>) || {}),
    ...((pkgData.devDependencies as Record<string, string>) || {}),
  }
  const isTypeScript = hasTsConfig || 'typescript' in deps
  const isReact = 'react' in deps || 'next' in deps
  const isVue = 'vue' in deps
  const isNode = hasPackageJson
  const isPython = hasPyProject || hasRequirements
  const isFastAPI = 'fastapi' in deps
  const isNextJS = 'next' in deps
  const isExpress = 'express' in deps || 'fastify' in deps
  const isDocker = hasDockerfile

  // ── Detection summary ──
  const tags: string[] = []
  if (isTypeScript) tags.push('TypeScript')
  if (isReact) tags.push('React')
  if (isVue) tags.push('Vue')
  if (isNextJS) tags.push('Next.js')
  if (isExpress) tags.push('Node.js API')
  if (isFastAPI) tags.push('FastAPI')
  if (isPython) tags.push('Python')
  if (isDocker) tags.push('Docker')
  if (hasTailwind) tags.push('Tailwind CSS')
  if (hasGitHubActions) tags.push('CI/CD')

  lines.push('── Detected Stack ──')
  lines.push('')
  if (tags.length > 0) {
    lines.push(`  ${tags.join(' · ')}`)
  } else {
    lines.push('  (generic project — no specific framework detected)')
  }
  lines.push('')

  // ── Skill recommendations ──
  const communitySkills = getAvailableSkills()
  const recommendedSkills: string[] = []

  // Always useful
  recommendedSkills.push('code-review')
  recommendedSkills.push('systematic-debugging')

  if (isTypeScript || isNode) {
    recommendedSkills.push('github-ops')
  }
  if (isReact || isVue || isNextJS) {
    recommendedSkills.push('frontend-design')
  }
  if (hasGitHubActions) {
    recommendedSkills.push('security-review')
  }
  if (isPython) {
    recommendedSkills.push('doc-generator')
  }

  // Filter to only those in the registry
  const available = recommendedSkills.filter((name) => communitySkills.some((s) => s.name === name))

  lines.push('── Recommended Skills ──')
  lines.push('')
  if (available.length > 0) {
    for (const name of available) {
      const entry = communitySkills.find((s) => s.name === name)!
      lines.push(`  /install-skill ${name.padEnd(26)} ${entry.description}`)
    }
  }
  lines.push('  /browse-skills           Browse all community skills')
  lines.push('')

  // ── Provider recommendations ──
  const activeProviders = ctx.config.providers.filter((p) => p.status === 'active')
  const configured = activeProviders.filter((p) => p.apiKey && p.apiKey.trim() !== '')

  lines.push('── Provider Status ──')
  lines.push('')
  if (configured.length === 0) {
    lines.push('  ⚠ No providers have API keys configured.')
    lines.push('  Run /setup 2 to configure providers.')
    lines.push('')
    lines.push('  Recommended for this project:')
    if (isTypeScript || isNode || isReact) {
      lines.push('    • anthropic — Claude (code generation, review)')
      lines.push('    • openai   — GPT-5 (general purpose)')
    }
    if (isPython) {
      lines.push('    • anthropic — Claude (data science, ML)')
    }
  } else {
    lines.push(`  ${configured.length}/${activeProviders.length} providers configured`)
    for (const p of configured) {
      lines.push(`    ✅ ${p.id.padEnd(14)} ${p.name}`)
    }
  }
  lines.push('')

  // ── Config recommendations ──
  lines.push('── Configuration Tips ──')
  lines.push('')

  const hasProjectMipham = existsSync(join(cwd, '.mipham'))
  if (!hasProjectMipham) {
    lines.push('  /setup 1     Initialize .mipham/ + MIPHAM.md + config.yml')
  }

  const { listInstalledSkills } = await import('../skills/registry')
  const installed = listInstalledSkills()
  if (installed.length === 0 && available.length > 0) {
    lines.push('  Tip:         Install recommended skills above for better AI assistance')
  }

  if (isDocker && !hasProjectMipham) {
    lines.push('  Tip:         Add .mipham/ to .dockerignore for smaller images')
  }

  if (hasGitHubActions) {
    lines.push('  /setup 5     Configure tool permissions for CI/CD safety')
  }

  lines.push('  /setup       Full setup wizard (6 steps)')
  lines.push('  /help        All commands')
  lines.push('')

  return { content: lines.join('\n') }
}

const setupCmd: CommandHandler = async (ctx, args) => {
  const step = args[0]

  // ── Step selection ──
  if (step === '1' || step === 'init') {
    return setupStep1(ctx)
  }
  if (step === '2' || step === 'providers') {
    return setupStep2(ctx)
  }
  if (step === '3' || step === 'model') {
    return setupStep3(ctx)
  }
  if (step === '4' || step === 'skills') {
    return setupStep4(ctx)
  }
  if (step === '5' || step === 'permissions') {
    return setupStep5(ctx)
  }
  if (step === '6' || step === 'shell') {
    return setupStep6(ctx)
  }

  // ── Check existing setup status ──
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const cwd = process.cwd()
  const home = process.env.HOME || '~'

  const hasProjectMipham = existsSync(join(cwd, 'MIPHAM.md'))
  const hasProjectConfig = existsSync(join(cwd, '.mipham', 'config.yml'))
  const hasUserConfig = existsSync(join(home, '.mipham', 'config.yml'))
  const hasMiphamDir = existsSync(join(cwd, '.mipham'))

  const activeProviders = ctx.config.providers.filter((p) => p.status === 'active').length
  const totalProviders = ctx.config.providers.length
  const skills = ctx.skillsLoader?.list() || []
  const standardSkills = skills.filter((s: { type: string }) => s.type === 'standard').length
  const miphamSkills = skills.filter((s: { type: string }) => s.type === 'mipham').length

  const statusIcon = (ok: boolean) => (ok ? '✅' : '⬜')

  return {
    content: `── Mipham Code Setup ──


  Project Status
  ${statusIcon(hasMiphamDir)} .mipham/ directory  ${hasMiphamDir ? '(config + metadata)' : '(not created)'}
  ${statusIcon(hasProjectMipham)} MIPHAM.md           ${hasProjectMipham ? '(project personality)' : '(not created)'}
  ${statusIcon(hasProjectConfig)} Project config       ${hasProjectConfig ? '~/.mipham/config.yml' : '(not created)'}
  ${statusIcon(hasUserConfig)} User config          ${hasUserConfig ? '~/.mipham/config.yml' : '(not created)'}

  Providers
  ${activeProviders}/${totalProviders} active  ·  Current: ${ctx.providerId}/${ctx.modelId}

  Skills
  ${skills.length} loaded (${standardSkills} standard + ${miphamSkills} mipham)

  Permissions
  Mode: ${ctx.config.permission}  ·  Tools: ${ctx.engine.getTools().size}


  ── Setup Steps ──

  1. Initialize Project    /setup 1   Create .mipham/ + MIPHAM.md + config.yml
  2. Configure Providers   /setup 2   Set API keys, enable/disable providers
  3. Set Default Model     /setup 3   Choose your preferred provider & model
  4. Install Skills        /setup 4   Browse and install community skills
  5. Permissions Setup     /setup 5   Configure tool access and security
  6. Shell Integration     /setup 6   Add \`mipham\` to PATH, IDE setup

  Run: /setup <number>    or chat: "help me set up Mipham Code"`,
  }
}

async function setupStep1(ctx: CommandContext): Promise<CommandResult> {
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const cwd = process.cwd()

  const miphamDir = join(cwd, '.mipham')
  const miphamPath = join(cwd, 'MIPHAM.md')
  const configPath = join(miphamDir, 'config.yml')

  const created: string[] = []
  const skipped: string[] = []

  // Create .mipham/ directory
  if (!existsSync(miphamDir)) {
    mkdirSync(miphamDir, { recursive: true })
    created.push('.mipham/')
  } else {
    skipped.push('.mipham/ (already exists)')
  }

  // Create project config if missing
  if (!existsSync(configPath)) {
    // Generate a user-friendly config with all providers pre-populated.
    // Users just need to replace the API key placeholders with their real keys.
    const activeProviders = ctx.config.providers.filter((p) => p.status === 'active')
    const providerYaml = activeProviders
      .map((p) => {
        const comment =
          p.id === 'anthropic'
            ? '# Get key: https://console.anthropic.com/'
            : p.id === 'openai'
              ? '# Get key: https://platform.openai.com/api-keys'
              : p.id === 'deepseek'
                ? '# Get key: https://platform.deepseek.com/api_keys'
                : p.id === 'kimi'
                  ? '# Get key: https://platform.moonshot.cn/'
                  : p.id === 'doubao'
                    ? '# Get key: https://console.volcengine.com/ark'
                    : p.id === 'hunyuan'
                      ? '# Get key: https://console.cloud.tencent.com/hunyuan'
                      : p.id === 'qwen'
                        ? '# Get key: https://dashscope.console.aliyun.com/apiKey'
                        : p.id === 'google'
                          ? '# Get key: https://aistudio.google.com/apikey'
                          : ''
        const baseUrlLine = p.baseUrl ? `\n    baseUrl: "${p.baseUrl}"` : ''
        return `  ${comment}
  - id: ${p.id}
    name: "${p.name}"${baseUrlLine}
    apiKey: "\${${p.id.toUpperCase()}_API_KEY}"`
      })
      .join('\n\n')

    const defaultConfig = `# Mipham Code — User Configuration
# Location: ~/.mipham/config.yml
# Docs:     https://mipham.ai/code/docs/config
#
# ═══ Quick Start ═══
# 1. Set your API keys below (replace the placeholder values)
# 2. Save the file
# 3. Run 'mipham' — it auto-detects configured providers
#
# ═══ Environment Variables ═══
# Instead of editing this file, you can set env vars:
#   export ANTHROPIC_API_KEY="sk-ant-..."
#   export OPENAI_API_KEY="sk-..."
#   (The \${VAR} syntax below reads from environment variables)

# ── Defaults ──
defaultProvider: ${ctx.providerId}
defaultModel: ${ctx.modelId}
permission: ask

# ── Providers (8 configured, just add your API keys) ──
providers:
${providerYaml}
`
    writeFileSync(configPath, defaultConfig, 'utf-8')
    created.push('.mipham/config.yml')
  } else {
    skipped.push('.mipham/config.yml (already exists)')
  }

  // Create MIPHAM.md if missing
  if (!existsSync(miphamPath)) {
    const projectName = cwd.split('/').pop() || 'my-project'
    const defaultMipham = `---
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
    writeFileSync(miphamPath, defaultMipham, 'utf-8')
    created.push('MIPHAM.md')
  } else {
    skipped.push('MIPHAM.md (already exists)')
  }

  const lines: string[] = ['── Step 1: Initialize Project ──', '']
  if (created.length > 0) {
    lines.push('Created:')
    for (const c of created) lines.push(`  ✅ ${c}`)
  }
  if (skipped.length > 0) {
    lines.push('')
    lines.push('Skipped (already configured):')
    for (const s of skipped) lines.push(`  ⏭  ${s}`)
  }
  lines.push('')
  lines.push('Next: /setup 2 to configure providers')

  return { content: lines.join('\n') }
}

async function setupStep2(ctx: CommandContext): Promise<CommandResult> {
  const active = ctx.config.providers.filter((p) => p.status === 'active')
  const upcoming = ctx.config.providers.filter((p) => p.status === 'upcoming')

  const lines: string[] = [
    '── Step 2: Configure Providers ──',
    '',
    `Active providers (${active.length}):`,
    ...active.map((p) => `  ✅ ${p.id.padEnd(14)} ${p.name.padEnd(20)} ${p.protocol}`),
    '',
    `Upcoming (${upcoming.length}):`,
    ...upcoming.map((p) => `  🔶 ${p.id.padEnd(14)} ${p.name.padEnd(20)} ${p.protocol}`),
    '',
    '── API Key Setup ──',
    '',
    'Set API keys via environment variables or .mipham/config.yml:',
    '',
    '  export ANTHROPIC_API_KEY="sk-ant-..."',
    '  export OPENAI_API_KEY="sk-..."',
    '  export DEEPSEEK_API_KEY="sk-..."',
    '  export QWEN_API_KEY="sk-..."',
    '  export DOUBAO_API_KEY="..."',
    '  export HUNYUAN_API_KEY="..."',
    '',
    'Or add to ~/.mipham/config.yml:',
    '  providers:',
    '    - id: anthropic',
    '      apiKey: $ANTHROPIC_API_KEY',
    '',
    'Current: ' + ctx.providerId + ' / ' + ctx.modelId,
    '',
    'Next: /setup 3 to choose default model',
  ]

  return { content: lines.join('\n') }
}

async function setupStep3(ctx: CommandContext): Promise<CommandResult> {
  const activeProviders = ctx.config.providers.filter((p) => p.status === 'active')

  const lines: string[] = [
    '── Step 3: Set Default Model ──',
    '',
    `Current: ${ctx.providerId} / ${ctx.modelId}`,
    '',
    'Available providers & models:',
    '',
  ]

  for (const p of activeProviders) {
    lines.push(`  ${p.id}${p.id === ctx.providerId ? ' ← current' : ''}`)
    for (const m of p.models.filter((m) => m.status === 'active')) {
      const marker = m.id === ctx.modelId ? ' ★' : '  '
      lines.push(
        `${marker}  ${m.id.padEnd(30)} ${m.contextWindow.toLocaleString()} ctx  ${m.vision ? '🖼' : '📝'}`,
      )
    }
    lines.push('')
  }

  lines.push('To switch: /switch <provider> <model>')
  lines.push('To make permanent: edit .mipham/config.yml → defaultProvider / defaultModel')
  lines.push('')
  lines.push('Next: /setup 4 to install skills')

  return { content: lines.join('\n') }
}

async function setupStep4(ctx: CommandContext): Promise<CommandResult> {
  const counts = ctx.skillsLoader?.countByType() ?? { standard: 0, mipham: 0, total: 0 }
  const standardNames = ctx.skillsLoader?.getNamesByType('standard') ?? []
  const miphamNames = ctx.skillsLoader?.getNamesByType('mipham') ?? []

  return {
    content: `── Step 4: Install Skills ──

Skills extend Mipham Code with specialized capabilities.

Built-in skills (${counts.total} total):
  Standard (${counts.standard}):  ${standardNames.join(', ')}
  Mipham (${counts.mipham}):    ${miphamNames.join(', ')}

Community skills:
  Coming soon — the Mipham Code skills marketplace will let you
  browse and install community-contributed skills.

  For now, add custom skills manually:
  1. Create a .SKILL.md file in .mipham/skills/
  2. Use /reload-skills to load it

Skill file template:
  ---
  name: my-skill
  description: What this skill does
  version: 1.0.0
  type: standard
  ---
  # My Skill
  [instructions for the AI]

Next: /setup 5 to configure permissions`,
  }
}

async function setupStep5(ctx: CommandContext): Promise<CommandResult> {
  return {
    content: `── Step 5: Permissions Setup ──

Current mode: ${ctx.config.permission}

Permission levels:
  auto    — Run tools automatically (suitable for sandboxed envs)
  ask     — Prompt before each tool execution (default, recommended)
  bypass  — Skip all checks (⚠ only for trusted codebases)

  Change with: /config permission <level>

Available tools (${ctx.engine.getTools().size}):
  File:  read, write, edit, glob, grep
  Exec:  bash, git, task
  Agent: agent, memory, plan, skill
  Net:   web-fetch, web-search
  Sys:   config, mcp

Each tool category can be configured independently in .mipham/config.yml:
  permissions:
    file: ask
    exec: ask
    network: auto

Next: /setup 6 for shell integration`,
  }
}

async function setupStep6(_ctx: CommandContext): Promise<CommandResult> {
  return {
    content: `── Step 6: Shell Integration ──

Add Mipham Code to your shell:

  # Add to ~/.zshrc or ~/.bashrc
  alias mipham='cd ~/your-project && bun run ~/path/to/mipham-code/apps/cli/bin/mipham.ts'

  # Or if installed globally:
  alias mipham='mipham'

IDE Integration:
  VS Code     — coming soon (extension marketplace)
  JetBrains   — coming soon (plugin)
  Terminal    — run \`mipham\` in any terminal

Quick launch:
  Ctrl+P      Open model picker
  /help       Show all commands
  Esc         Exit

── Setup Complete! ──

You're all set. Start a conversation:
  "help me build a REST API"
  "review my code"
  "explain this project"

For help at any time: /help`,
  }
}

const addDirCmd: CommandHandler = async (_ctx, args) => {
  const dir = args[0]
  if (!dir) {
    return {
      content: `Usage: /add-dir <path>

Add a directory to Mipham Code's allowed workspace paths.
This grants the AI permission to read/write files in that directory.

Examples:
  /add-dir ~/projects/my-api
  /add-dir /usr/local/share/data

Current allowed directories:
  • ${process.cwd()}  (project root, always allowed)

Note: For security, tools like bash already respect .mipham/config.yml
permission boundaries. Adding directories here extends read/write access.`,
    }
  }

  const { existsSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const resolved = resolve(dir.replace(/^~/, process.env.HOME || '~'))

  if (!existsSync(resolved)) {
    return { content: `✗ Directory not found: ${resolved}\n\nCheck the path and try again.` }
  }

  return {
    content: `✓ Directory registered: ${resolved}

To persist across sessions, add to .mipham/config.yml:
  workspace:
    extraDirs:
      - ${resolved}

The AI can now access files in this directory.
Permission level is controlled by /config permission <level>.`,
  }
}

const promptAuditCmd: CommandHandler = async () => {
  const { existsSync, readFileSync, readdirSync, statSync } = await import('node:fs')
  const { join, basename } = await import('node:path')
  const cwd = process.cwd()

  // Patterns that suggest prompts written for older/less-capable models
  const AUDIT_RULES: Array<{
    id: string
    pattern: RegExp
    severity: 'low' | 'medium' | 'high'
    message: string
    suggestion: string
  }> = [
    {
      id: 'over-explaining',
      pattern:
        /you are (a|an) (helpful |friendly |knowledgeable )?(AI |language model |assistant)/i,
      severity: 'low',
      message: 'Self-identification preamble ("You are a...")',
      suggestion: "Modern models don't need role preamble. Remove or shorten to 1 line.",
    },
    {
      id: 'step-by-step',
      pattern: /(think|reason|work) (step[ -]?by[ -]?step|through this|carefully about this)/i,
      severity: 'low',
      message: 'Step-by-step reasoning prompt',
      suggestion: 'Reasoning models handle this natively. Remove for token savings.',
    },
    {
      id: 'do-not-list',
      pattern:
        /(do not|never|you must not|don't|under no circumstances).*\n.*(do not|never|you must not|don't)/i,
      severity: 'medium',
      message: 'Multiple "do not" constraints',
      suggestion: 'Modern models need fewer prohibitions. Consolidate to 1-2 key constraints.',
    },
    {
      id: 'token-waste',
      pattern:
        /(remember|keep in mind|it is important to note|please note that|i want to emphasize)/i,
      severity: 'low',
      message: 'Filler emphasis phrases ("remember", "please note")',
      suggestion: 'Remove filler. State the instruction directly.',
    },
    {
      id: 'format-over-spec',
      pattern: /(you must (always |only )?respond (in|with|using) (JSON|XML|YAML|markdown|HTML))/i,
      severity: 'low',
      message: 'Over-specified output format',
      suggestion: 'Modern models follow format instructions with fewer words. Shorten.',
    },
    {
      id: 'example-overload',
      pattern: /((?:example|for instance|e\.g\.,).*\n){3,}/i,
      severity: 'low',
      message: 'Three or more examples in sequence',
      suggestion: '1-2 examples suffice for modern models. Remove redundant ones.',
    },
    {
      id: 'old-model-ref',
      pattern: /(GPT-3|GPT-3\.5|Claude\s*[12][^3]|text-davinci|command-r|llama\s*2)/i,
      severity: 'high',
      message: 'Reference to older model',
      suggestion: 'Update model references to current generation (Sonnet 5, Opus 5, GPT-5, etc.).',
    },
    {
      id: 'long-preamble',
      pattern: /^.{200,}$/m,
      severity: 'medium',
      message: 'Very long single-line instructions (200+ chars)',
      suggestion: 'Break into bullet points. Modern models parse structured prompts better.',
    },
    {
      id: 'verbose-constraint',
      pattern:
        /you (must|should|shall) (always |only |never )?(ensure|guarantee|verify|validate|confirm|cross-check|double-check)/i,
      severity: 'medium',
      message: 'Overly verbose constraint language',
      suggestion: 'Replace "you must ensure that" with imperative: "Ensure".',
    },
  ]

  // Files to scan
  const scanDirs = [
    join(cwd, '.mipham', 'skills'),
    join(cwd, '.mipham', 'rules'),
    join(cwd, '.claude'),
  ]
  const skillFiles: string[] = []
  // Also check standard project files
  const projectFiles = [join(cwd, 'CLAUDE.md'), join(cwd, 'MIPHAM.md'), join(cwd, 'PRODUCT.md')]

  // Collect skill/rules files
  for (const dir of scanDirs) {
    try {
      if (!existsSync(dir)) continue
      const walk = (d: string) => {
        const entries = readdirSync(d)
        for (const e of entries) {
          const fp = join(d, e)
          const st = statSync(fp)
          if (st.isDirectory()) {
            walk(fp)
            continue
          }
          if (['.md', '.SKILL.md', '.mipham-skill.md', '.txt'].some((ext) => fp.endsWith(ext))) {
            skillFiles.push(fp)
          }
        }
      }
      walk(dir)
    } catch {
      /* skip */
    }
  }

  const allFiles = [...new Set([...projectFiles.filter((f) => existsSync(f)), ...skillFiles])]

  if (allFiles.length === 0) {
    return {
      content: [
        '🔍 Prompt Audit',
        '',
        'No prompt files found to audit.',
        'Place skills in .mipham/skills/ and rules in .mipham/rules/.',
      ].join('\n'),
    }
  }

  // Scan each file
  const results: Array<{
    file: string
    line: number
    ruleId: string
    severity: string
    message: string
    suggestion: string
  }> = []

  for (const fp of allFiles) {
    try {
      const content = readFileSync(fp, 'utf-8')
      const lines = content.split('\n')
      for (const rule of AUDIT_RULES) {
        // Multi-line pattern: check full content
        if (rule.id === 'do-not-list' || rule.id === 'example-overload') {
          if (rule.pattern.test(content)) {
            // Find approx line
            const match = rule.pattern.exec(content)
            const idx = match ? content.slice(0, match.index).split('\n').length : 1
            results.push({
              file: fp.replace(cwd + '/', ''),
              line: idx,
              ruleId: rule.id,
              severity: rule.severity,
              message: rule.message,
              suggestion: rule.suggestion,
            })
          }
          continue
        }

        // Line-by-line patterns
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          if (rule.pattern.test(line)) {
            results.push({
              file: fp.replace(cwd + '/', ''),
              line: i + 1,
              ruleId: rule.id,
              severity: rule.severity,
              message: rule.message,
              suggestion: rule.suggestion,
            })
          }
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }

  // Format output
  const severityIcon: Record<string, string> = { high: '🔴', medium: '🟡', low: '🟢' }
  const grouped: Record<string, typeof results> = {}
  for (const r of results) {
    const key = r.file
    if (!grouped[key]) grouped[key] = []
    grouped[key]!.push(r)
  }

  const output: string[] = [
    `🔍 Prompt Audit — ${allFiles.length} file(s) scanned, ${results.length} finding(s)`,
    '',
  ]

  if (results.length === 0) {
    output.push('✅ All prompts look optimized for modern models. No issues found.')
  } else {
    for (const [file, items] of Object.entries(grouped)) {
      output.push(`📄 ${file} (${items!.length} finding${items!.length > 1 ? 's' : ''})`)
      for (const item of items!) {
        output.push(
          `  ${severityIcon[item.severity] || '⚪'} L${item.line}: [${item.ruleId}] ${item.message}`,
        )
        output.push(`     → ${item.suggestion}`)
      }
      output.push('')
    }
  }

  output.push('─'.repeat(60))
  output.push('Scanned: ' + allFiles.map((f) => basename(f)).join(', '))

  return { content: output.join('\n') }
}

const securityCmd: CommandHandler = async () => {
  const findings: string[] = []
  const ok: string[] = []

  // Check for common security issues
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const cwd = process.cwd()

  // 1. Check .gitignore for sensitive patterns
  if (existsSync(join(cwd, '.gitignore'))) {
    const gi = readFileSync(join(cwd, '.gitignore'), 'utf-8')
    const hasEnv = gi.includes('.env')
    const hasKeys = gi.includes('*.key') || gi.includes('*.pem')
    if (hasEnv && hasKeys) {
      ok.push('.gitignore covers .env + key files')
    } else {
      findings.push('Add .env, *.key, *.pem to .gitignore')
    }
  } else {
    findings.push('No .gitignore found — create one with .env, node_modules, dist')
  }

  // 2. Check for hardcoded secrets (quick grep for common patterns)
  // ⚠ Security: results are redacted — only file:line locations are shown, never values
  try {
    const { execSync } = await import('node:child_process')
    const secretPatterns = execSync(
      `grep -rIn --include="*.ts" --include="*.js" --include="*.yml" --include="*.yaml" --include="*.json" -E "(API_KEY|SECRET|PASSWORD|TOKEN)\\s*=\\s*['\\\"][^$]" ${cwd} 2>/dev/null | grep -v node_modules | grep -v '.git/' | head -5 || echo ""`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim()
    if (secretPatterns) {
      // Redact the actual values — only show file:line locations
      const redacted = secretPatterns
        .split('\n')
        .map((l) => {
          const colonIdx = l.indexOf(':')
          const secondColon = l.indexOf(':', colonIdx + 1)
          if (secondColon > 0) {
            return '    ' + l.slice(0, secondColon) + ' [VALUE REDACTED]'
          }
          return '    ' + l + ' [REDACTED]'
        })
        .join('\n')
      findings.push(
        `⚠ Hardcoded secrets detected (values redacted for security):\n${redacted}\n\n  Replace with env vars: \${VAR_NAME} syntax`,
      )
    } else {
      ok.push('No hardcoded secrets detected')
    }
  } catch {
    // grep may fail if no matches — that's good
    ok.push('No hardcoded secrets detected (quick scan)')
  }

  // 3. Check for TLS in dependencies
  if (existsSync(join(cwd, 'package.json'))) {
    ok.push('package.json present — dependencies manageable')
  }

  // 4. Check for license
  if (existsSync(join(cwd, 'LICENSE'))) {
    ok.push('LICENSE file present')
  } else {
    findings.push('No LICENSE file — add Apache 2.0 or appropriate license')
  }

  // 5. CI/CD
  if (existsSync(join(cwd, '.github', 'workflows'))) {
    ok.push('CI/CD workflows configured')
  } else {
    findings.push('No CI/CD workflows found — add .github/workflows/')
  }

  const lines: string[] = ['── Security Review ──', '', `Scanning: ${cwd}`, '']

  if (ok.length > 0) {
    lines.push(`✅ Passed (${ok.length}):`)
    for (const o of ok) lines.push(`  • ${o}`)
  }
  if (findings.length > 0) {
    lines.push('')
    lines.push(`⚠  Findings (${findings.length}):`)
    for (const f of findings) lines.push(`  • ${f}`)
  }
  lines.push('')
  lines.push('For a full audit: type "audit my project for security issues" in chat.')

  return { content: lines.join('\n') }
}

const trustCmd: CommandHandler = (ctx) => {
  const trust = getWorkspaceTrust()
  const cwd = process.cwd()
  const trusted = trust.listTrusted()

  const lines: string[] = [
    '── Workspace Trust ──',
    '',
    `Current directory: ${cwd}`,
    `Trusted: ${trust.isTrusted(cwd) ? '✅ Yes' : '⚠️  No (restart to trust)'}`,
    `Trust store: ${trust.getStorePath()}`,
    '',
  ]

  if (trusted.length === 0) {
    lines.push('No trusted workspaces configured.')
    lines.push('')
    lines.push('Trust a workspace: restart Mipham Code in the directory')
    lines.push('and accept the trust prompt.')
  } else {
    lines.push(`Trusted workspaces (${trusted.length}):`)
    for (const dir of trusted) {
      const marker = cwd.startsWith(dir) ? ' ← current' : ''
      lines.push(`  • ${dir}${marker}`)
    }
    lines.push('')
    lines.push('Remove a workspace: delete the directory entry from the trust store.')
  }

  return { content: lines.join('\n') }
}
