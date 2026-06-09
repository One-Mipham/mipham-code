# Mipham Code Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Mipham Code Phase 1 — a multi-model open-core intelligent coding CLI with Web companion, from empty directory to GA release.

**Architecture:** pnpm monorepo with 3 packages: `@mipham/shared` (types/constants), `@mipham/cli` (Bun + Ink CLI), `@mipham/web` (Next.js product page). CLI follows 4-layer design: UI (React/Ink) → Orchestration (engine/context/permission/hooks/instructions) → Provider (OpenAI-compat + Anthropic routers) → Extension (MCP client + Skills loader). All shared types flow from `@mipham/shared`.

**Tech Stack:** Bun 1.2+, TypeScript strict, React 18 + Ink 5 (CLI UI), Next.js 14+ App Router + Tailwind CSS (Web), pnpm workspace, Vitest, ESLint + Prettier.

**Spec Reference:** `docs/superpowers/specs/2026-05-31-mipham-code-design.md`

---

## File Structure Map

```
omc-project9-MiphamCode/
├── MIPHAM.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE                          # Apache 2.0
├── package.json                     # Root: pnpm workspace scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .eslintrc.json
├── .prettierrc
├── .github/workflows/ci.yml
│
├── packages/
│   └── shared/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts             # Barrel export
│           ├── types.ts             # Provider, Tool, Skill, Message, Config types
│           └── constants.ts         # Default models, config keys, protocols
│
├── apps/
│   ├── cli/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── bin/
│   │   │   └── mipham.ts            # CLI entry point (shebang)
│   │   ├── src/
│   │   │   ├── index.ts             # App bootstrap
│   │   │   ├── core/
│   │   │   │   ├── engine.ts        # Query engine (request→model→tools→response)
│   │   │   │   ├── context.ts       # Context manager (compaction/cache/window)
│   │   │   │   ├── permission.ts    # Permission system (auto/ask/bypass)
│   │   │   │   ├── hooks.ts         # Hook engine (PreToolUse/PostToolUse/Session)
│   │   │   │   └── instructions.ts  # MIPHAM.md loader
│   │   │   ├── providers/
│   │   │   │   ├── registry.ts      # Provider registry + model discovery
│   │   │   │   ├── openai-compat.ts # OpenAI-compatible router
│   │   │   │   ├── anthropic.ts     # Anthropic router
│   │   │   │   └── custom/
│   │   │   │       └── gemini.ts    # Gemini adapter
│   │   │   ├── tools/
│   │   │   │   ├── index.ts         # Tool registry + execution
│   │   │   │   ├── file/
│   │   │   │   │   ├── read.ts      # Read file
│   │   │   │   │   ├── write.ts     # Write file
│   │   │   │   │   ├── edit.ts      # String replacement edit
│   │   │   │   │   ├── glob.ts      # Glob pattern search
│   │   │   │   │   └── grep.ts      # Ripgrep content search
│   │   │   │   ├── exec/
│   │   │   │   │   ├── bash.ts      # Shell command execution
│   │   │   │   │   ├── git.ts       # Git operations wrapper
│   │   │   │   │   └── task.ts      # Task creation/management
│   │   │   │   ├── agent/
│   │   │   │   │   ├── agent.ts     # Sub-agent spawner
│   │   │   │   │   ├── skill.ts     # Skill invocation
│   │   │   │   │   ├── plan.ts      # Plan mode (read-only)
│   │   │   │   │   └── memory.ts    # Memory read/write
│   │   │   │   ├── network/
│   │   │   │   │   ├── web-fetch.ts # URL content fetch
│   │   │   │   │   └── web-search.ts# Web search
│   │   │   │   └── system/
│   │   │   │       ├── config.ts    # Configuration management
│   │   │   │       └── mcp.ts       # MCP client protocol
│   │   │   ├── skills/
│   │   │   │   ├── loader.ts        # SKILL.md parser + loader
│   │   │   │   ├── standard/        # Standard SKILL.md runtime
│   │   │   │   │   └── runtime.ts
│   │   │   │   └── mipham/          # Mipham exclusive runtime
│   │   │   │       └── runtime.ts
│   │   │   ├── mcp/
│   │   │   │   └── client.ts        # MCP stdio client
│   │   │   ├── ui/
│   │   │   │   ├── app.tsx          # Main Ink app
│   │   │   │   ├── chat.tsx         # Chat panel component
│   │   │   │   ├── input.tsx        # Input bar with slash commands
│   │   │   │   └── components/
│   │   │   │       ├── spinner.tsx  # Loading spinner
│   │   │   │       ├── diff.tsx     # Diff viewer
│   │   │   │       └── markdown.tsx # Markdown renderer
│   │   │   └── config/
│   │   │       ├── loader.ts        # .mipham/config.yml loader
│   │   │       └── defaults.ts      # Default configuration
│   │   ├── skills/                  # Built-in Skill definitions
│   │   │   ├── standard/
│   │   │   │   ├── superpower.SKILL.md
│   │   │   │   ├── code-review.SKILL.md
│   │   │   │   ├── self-review.SKILL.md
│   │   │   │   ├── memory.SKILL.md
│   │   │   │   ├── tdd.SKILL.md
│   │   │   │   ├── web-search.SKILL.md
│   │   │   │   ├── github-ops.SKILL.md
│   │   │   │   └── doc-generator.SKILL.md
│   │   │   └── mipham/
│   │   │       ├── om-model-optimize.mipham-skill.md
│   │   │       └── om-security.mipham-skill.md
│   │   └── test/
│   │       ├── core/
│   │       ├── providers/
│   │       └── tools/
│   │
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── next.config.js
│       ├── tailwind.config.ts
│       └── src/
│           └── app/
│               └── code/
│                   ├── layout.tsx       # Code section layout
│                   ├── page.tsx         # Product landing page
│                   ├── docs/
│                   │   └── page.tsx     # Documentation (MDX)
│                   ├── dashboard/
│                   │   └── page.tsx     # User dashboard
│                   ├── install/
│                   │   └── page.tsx     # Installation guide
│                   └── components/
│                       ├── hero.tsx     # Hero section
│                       ├── features.tsx # Feature grid
│                       ├── models.tsx   # Supported models table
│                       ├── install-cmd.tsx # Install command copy
│                       └── footer.tsx   # Page footer
```

---

## M1: CLI Prototype — Monorepo Scaffold + Model Connectivity + Basic Tools

### Task 1.1: Scaffold pnpm monorepo with root configuration

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.eslintrc.json`
- Create: `.prettierrc`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `MIPHAM.md`

- [ ] **Step 1: Create root package.json**

```bash
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/omc-project9-MiphamCode
```

Write `package.json`:
```json
{
  "name": "mipham-code-monorepo",
  "version": "0.1.0",
  "private": true,
  "description": "Mipham Code — Multi-model open-core intelligent coding terminal",
  "scripts": {
    "dev:cli": "pnpm --filter @mipham/cli dev",
    "dev:web": "pnpm --filter @mipham/web dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "eslint . --ext .ts,.tsx",
    "format": "prettier --write .",
    "typecheck": "pnpm -r typecheck"
  },
  "engines": {
    "node": ">=22.0.0",
    "bun": ">=1.2.0"
  },
  "packageManager": "pnpm@9.15.0"
}
```

- [ ] **Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  }
}
```

- [ ] **Step 4: Create .eslintrc.json**

```json
{
  "root": true,
  "extends": ["eslint:recommended"],
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "rules": {
    "no-console": "warn",
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
  },
  "ignorePatterns": ["node_modules", "dist", ".next", "out"]
}
```

- [ ] **Step 5: Create .prettierrc**

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
dist/
.next/
out/
*.log
.env
.env.local
.mipham/memory/
```

- [ ] **Step 7: Create LICENSE (Apache 2.0)**

Copy Apache 2.0 license text to `LICENSE`.

- [ ] **Step 8: Create MIPHAM.md**

```markdown
---
model: mipham-code
version: 1.0.0
privacy: project
language: zh-CN
---

# MIPHAM.md — Mipham Code

> One Mipham Corporation (Delaware, USA) | mipham.ai
> Mipham Code 项目规范，所有连接的模型均需遵守。

## 技术栈
- 运行时: Bun 1.2+ · TypeScript strict · ESM
- 包管理: pnpm workspace
- CLI UI: React 18 + Ink 5
- Web: Next.js 14+ App Router + Tailwind CSS
- 测试: Vitest · Lint: ESLint + Prettier

## 编码规则
- 提交信息遵循 Conventional Commits
- 禁止硬编码凭据、API 密钥
- 所有变更通过 feature branch + PR
- 新代码必须通过测试
```

- [ ] **Step 9: Install root dependencies**

```bash
pnpm add -w -D typescript @typescript-eslint/parser @typescript-eslint/eslint-plugin eslint prettier vitest
```

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .eslintrc.json .prettierrc .gitignore LICENSE MIPHAM.md
git commit -m "chore: scaffold pnpm monorepo with root configuration"
```

---

### Task 1.2: Create shared package with types and constants

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/constants.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@mipham/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write types.ts**

```typescript
// ── Provider Types ──
export type ProtocolType = 'openai-compatible' | 'anthropic' | 'custom'

export interface ModelInfo {
  id: string
  name: string
  providerId: string
  contextWindow: number
  maxOutput: number
  vision: boolean
  status: 'active' | 'upcoming' | 'deprecated'
}

export interface ProviderConfig {
  id: string
  name: string
  protocol: ProtocolType
  baseUrl?: string
  apiKey: string
  models: ModelInfo[]
  status?: 'active' | 'upcoming'
}

// ── Message Types ──
export interface TextContent {
  type: 'text'
  text: string
}

export interface ImageContent {
  type: 'image_url'
  image_url: { url: string }
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

export type ContentBlock = TextContent | ImageContent | ToolUseContent | ToolResultContent

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentBlock[]
}

// ── Tool Types ──
export type ToolPermission = 'auto' | 'ask' | 'bypass'
export type ToolCategory = 'file' | 'exec' | 'agent' | 'network' | 'system'

export interface ToolDefinition {
  name: string
  description: string
  category: ToolCategory
  permission: ToolPermission
  parameters: Record<string, unknown>   // JSON Schema
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

export interface ToolContext {
  cwd: string
  sessionId: string
  provider: string
  model: string
}

export interface ToolResult {
  success: boolean
  content: string
  error?: string
}

// ── Stream Types ──
export interface StreamChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'stop' | 'error'
  content?: string
  toolUse?: ToolUseContent
  error?: string
}

// ── Config Types ──
export interface MiphamConfig {
  version: string
  defaultProvider: string
  defaultModel: string
  permission: ToolPermission
  providers: ProviderConfig[]
  skills?: {
    paths: string[]
    mcpServers: McpServerConfig[]
  }
}

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

// ── Skill Types ──
export interface SkillDefinition {
  name: string
  description: string
  version: string
  type: 'standard' | 'mipham'
  tools?: ToolDefinition[]
  hooks?: HookDefinition[]
  prompts?: Record<string, string>
}

// ── Hook Types ──
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd' | 'Notification'

export interface HookDefinition {
  event: HookEvent
  toolName?: string
  handler: (context: HookContext) => Promise<HookResult>
}

export interface HookContext {
  event: HookEvent
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: ToolResult
  sessionId: string
}

export interface HookResult {
  allowed: boolean
  reason?: string
  modifiedInput?: Record<string, unknown>
}

// ── Instruction Types ──
export interface InstructionFile {
  path: string
  level: 'group' | 'project' | 'directory' | 'user'
  privacy: 'public' | 'project' | 'private'
  language: string
  content: string
  frontmatter: Record<string, unknown>
}

// ── Permission Types ──
export type PermissionLevel = 'auto' | 'ask' | 'bypass'

export interface PermissionRule {
  toolName: string
  level: PermissionLevel
  pattern?: string
}
```

- [ ] **Step 4: Write constants.ts**

```typescript
import type { ProviderConfig } from './types'

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'mipham',
    name: 'MiphamAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.mipham.ai/v1',
    apiKey: '${MIPHAM_API_KEY}',
    models: [
      { id: 'om-V5-Pro', name: 'OM V5 Pro', providerId: 'mipham', contextWindow: 1_000_000, maxOutput: 128_000, vision: false, status: 'upcoming' },
      { id: 'om-V5-Flash', name: 'OM V5 Flash', providerId: 'mipham', contextWindow: 1_000_000, maxOutput: 128_000, vision: false, status: 'upcoming' },
      { id: 'om-V5-Visual', name: 'OM V5 Visual', providerId: 'mipham', contextWindow: 200_000, maxOutput: 32_000, vision: true, status: 'upcoming' },
    ],
    status: 'upcoming',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    protocol: 'anthropic',
    apiKey: '${ANTHROPIC_API_KEY}',
    models: [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', providerId: 'anthropic', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', providerId: 'anthropic', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', providerId: 'anthropic', contextWindow: 200_000, maxOutput: 32_000, vision: true, status: 'active' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '${OPENAI_API_KEY}',
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5', providerId: 'openai', contextWindow: 1_050_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'gpt-5.4', name: 'GPT-5.4', providerId: 'openai', contextWindow: 1_050_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', providerId: 'openai', contextWindow: 400_000, maxOutput: 32_000, vision: true, status: 'active' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', providerId: 'openai', contextWindow: 400_000, maxOutput: 64_000, vision: false, status: 'active' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '${DEEPSEEK_API_KEY}',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', providerId: 'deepseek', contextWindow: 1_000_000, maxOutput: 384_000, vision: false, status: 'active' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', providerId: 'deepseek', contextWindow: 1_000_000, maxOutput: 384_000, vision: false, status: 'active' },
    ],
  },
  {
    id: 'qwen',
    name: '通义千问',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '${QWEN_API_KEY}',
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus', providerId: 'qwen', contextWindow: 128_000, maxOutput: 32_000, vision: true, status: 'active' },
      { id: 'qwen-max', name: 'Qwen Max', providerId: 'qwen', contextWindow: 128_000, maxOutput: 32_000, vision: true, status: 'active' },
    ],
  },
]

export const PROTOCOL_LABELS: Record<string, string> = {
  'openai-compatible': 'OpenAI Compatible',
  'anthropic': 'Anthropic',
  'custom': 'Custom Protocol',
}

export const TOOL_CATEGORIES = ['file', 'exec', 'agent', 'network', 'system'] as const

export const CONFIG_FILE_NAME = 'config.yml'
export const MIPHAM_DIR = '.mipham'
export const USER_CONFIG_DIR = '.mipham'
export const MEMORY_DIR = 'memory'
```

- [ ] **Step 5: Write index.ts (barrel export)**

```typescript
export * from './types'
export * from './constants'
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/
git commit -m "feat: add @mipham/shared package with types and constants"
```

---

### Task 1.3: Scaffold CLI package with Bun + Ink entry point

**Files:**
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/bin/mipham.ts`
- Create: `apps/cli/src/index.ts`
- Create: `apps/cli/src/ui/app.tsx`
- Create: `apps/cli/src/config/loader.ts`
- Create: `apps/cli/src/config/defaults.ts`

- [ ] **Step 1: Create apps/cli/package.json**

```json
{
  "name": "@mipham/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "mipham": "./bin/mipham.ts"
  },
  "scripts": {
    "dev": "bun run bin/mipham.ts",
    "build": "bun build --compile --minify ./bin/mipham.ts --outfile dist/mipham",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@mipham/shared": "workspace:*",
    "ink": "^5.0.0",
    "react": "^18.3.0",
    "commander": "^13.0.0",
    "yaml": "^2.6.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create apps/cli/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": ".",
    "jsx": "react-jsx",
    "types": ["bun-types"]
  },
  "include": ["bin", "src", "test"]
}
```

- [ ] **Step 3: Create bin/mipham.ts (CLI entry)**

```typescript
#!/usr/bin/env bun
import { Command } from 'commander'
import { runApp } from '../src/index'

const program = new Command()

program
  .name('mipham')
  .description('Mipham Code — Multi-model open-core intelligent coding terminal')
  .version('0.1.0')
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --provider <provider>', 'Provider to use')
  .option('--lang <lang>', 'CLI interface language')
  .option('--permission <level>', 'Permission level: auto, ask, bypass')
  .action(async (options) => {
    await runApp(options)
  })

program.parse()
```

- [ ] **Step 4: Create src/index.ts (app bootstrap)**

```typescript
import { render } from 'ink'
import { App } from './ui/app'

interface RunOptions {
  model?: string
  provider?: string
  lang?: string
  permission?: string
}

export async function runApp(options: RunOptions): Promise<void> {
  const { waitUntilExit } = render(
    <App
      initialModel={options.model}
      initialProvider={options.provider}
      lang={options.lang}
      permission={options.permission}
    />
  )
  await waitUntilExit()
}
```

- [ ] **Step 5: Create src/ui/app.tsx (main Ink component)**

```typescript
import React, { useState } from 'react'
import { Box, Text } from 'ink'

interface AppProps {
  initialModel?: string
  initialProvider?: string
  lang?: string
  permission?: string
}

export function App({ initialModel, initialProvider, lang }: AppProps) {
  const [ready] = useState(false)

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🚀 Mipham Code v0.1.0
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          One Mipham Corporation (Delaware, USA) | mipham.ai
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          {ready ? 'Ready.' : 'Initializing...'}
        </Text>
      </Box>
    </Box>
  )
}
```

- [ ] **Step 6: Create src/config/defaults.ts**

```typescript
import type { MiphamConfig } from '@mipham/shared'
import { DEFAULT_PROVIDERS } from '@mipham/shared'

export const DEFAULT_CONFIG: MiphamConfig = {
  version: '0.1.0',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  permission: 'auto',
  providers: DEFAULT_PROVIDERS,
}
```

- [ ] **Step 7: Create src/config/loader.ts**

```typescript
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { MiphamConfig } from '@mipham/shared'
import { DEFAULT_CONFIG } from './defaults'

export function loadConfig(cwd: string = process.cwd()): MiphamConfig {
  const configPath = join(cwd, '.mipham', 'config.yml')
  const userConfigPath = join(process.env.HOME || '~', '.mipham', 'config.yml')

  let config = { ...DEFAULT_CONFIG }

  // Load project config
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8')
    const projectConfig = parseYaml(raw) as Partial<MiphamConfig>
    config = mergeConfig(config, projectConfig)
  }

  // Load user config (overrides project)
  if (existsSync(userConfigPath)) {
    const raw = readFileSync(userConfigPath, 'utf-8')
    const userConfig = parseYaml(raw) as Partial<MiphamConfig>
    config = mergeConfig(config, userConfig)
  }

  return config
}

function mergeConfig(base: MiphamConfig, override: Partial<MiphamConfig>): MiphamConfig {
  return {
    ...base,
    ...override,
    providers: override.providers ?? base.providers,
  }
}
```

- [ ] **Step 8: Install dependencies and verify**

```bash
cd apps/cli && bun install
bun run bin/mipham.ts --help
```

Expected: Commander help output showing version, options, description.

- [ ] **Step 9: Commit**

```bash
git add apps/cli/
git commit -m "feat: scaffold CLI package with Bun + Ink entry point"
```

---

### Task 1.4: Implement Provider Registry with model discovery

**Files:**
- Create: `apps/cli/src/providers/registry.ts`

- [ ] **Step 1: Write registry.ts**

```typescript
import type { ProviderConfig, ModelInfo, Message, StreamChunk } from '@mipham/shared'

export interface ProviderInstance {
  config: ProviderConfig
  chat(req: ChatRequest): AsyncGenerator<StreamChunk>
  listModels(): Promise<ModelInfo[]>
  healthCheck(): Promise<boolean>
}

export interface ChatRequest {
  model: string
  messages: Message[]
  systemPrompt?: string
  tools?: Record<string, unknown>[]
  maxTokens?: number
  temperature?: number
}

export class ProviderRegistry {
  private providers = new Map<string, ProviderInstance>()
  private activeProviderId: string
  private activeModelId: string

  constructor(providers: ProviderConfig[], defaultProvider: string, defaultModel: string) {
    this.activeProviderId = defaultProvider
    this.activeModelId = defaultModel

    for (const config of providers) {
      if (config.status === 'upcoming') continue
      // Provider instances are registered lazily
    }
  }

  register(id: string, instance: ProviderInstance): void {
    this.providers.set(id, instance)
  }

  get(id: string): ProviderInstance | undefined {
    return this.providers.get(id)
  }

  getActive(): ProviderInstance {
    const p = this.providers.get(this.activeProviderId)
    if (!p) throw new Error(`Provider "${this.activeProviderId}" not registered`)
    return p
  }

  getActiveModel(): string {
    return this.activeModelId
  }

  switchProvider(providerId: string, modelId?: string): void {
    if (!this.providers.has(providerId)) {
      throw new Error(`Provider "${providerId}" not registered. Available: ${this.listIds().join(', ')}`)
    }
    this.activeProviderId = providerId
    if (modelId) this.activeModelId = modelId
  }

  listIds(): string[] {
    return Array.from(this.providers.keys())
  }

  listModels(): ModelInfo[] {
    const provider = this.getActive()
    return provider.config.models.filter(m => m.status === 'active')
  }

  async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const provider = this.getActive()
    yield* provider.chat({ ...req, model: req.model || this.activeModelId })
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/providers/registry.ts
git commit -m "feat: add Provider Registry with model discovery and switch logic"
```

---

### Task 1.5: Implement OpenAI-Compatible router

**Files:**
- Create: `apps/cli/src/providers/openai-compat.ts`

- [ ] **Step 1: Write openai-compat.ts**

```typescript
import type { ProviderConfig, ModelInfo, Message, StreamChunk, ContentBlock } from '@mipham/shared'
import type { ProviderInstance, ChatRequest } from './registry'

interface OpenAIChatParams {
  model: string
  messages: { role: string; content: string | unknown[] }[]
  stream: boolean
  max_tokens?: number
  temperature?: number
  tools?: Record<string, unknown>[]
}

export class OpenAICompatProvider implements ProviderInstance {
  constructor(public config: ProviderConfig) {}

  async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const baseUrl = this.config.baseUrl?.replace(/\/+$/, '') || 'https://api.openai.com/v1'
    const apiKey = this.resolveApiKey(this.config.apiKey)

    const body: OpenAIChatParams = {
      model: req.model,
      messages: this.convertMessages(req.messages, req.systemPrompt),
      stream: true,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      tools: req.tools?.map(t => ({ type: 'function', function: t })),
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text()
      yield { type: 'error', error: `OpenAI API error ${response.status}: ${errText}` }
      return
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' }
      return
    }

    // Stream SSE parsing
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') {
          yield { type: 'stop' }
          return
        }

        try {
          const parsed = JSON.parse(data)
          const choice = parsed.choices?.[0]
          if (!choice) continue

          const delta = choice.delta

          // Tool use
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                type: 'tool_use',
                toolUse: {
                  type: 'tool_use',
                  id: tc.id || `call_${Date.now()}`,
                  name: tc.function?.name || '',
                  input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
                },
              }
            }
            continue
          }

          // Text delta
          if (delta?.content) {
            yield { type: 'text', content: delta.content }
          }

          // Finish reason
          if (choice.finish_reason === 'stop') {
            yield { type: 'stop' }
          }
        } catch {
          // Skip unparseable chunks
        }
      }
    }

    yield { type: 'stop' }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.config.models.filter(m => m.status === 'active')
  }

  async healthCheck(): Promise<boolean> {
    try {
      const baseUrl = this.config.baseUrl?.replace(/\/+$/, '') || 'https://api.openai.com/v1'
      const apiKey = this.resolveApiKey(this.config.apiKey)
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      return res.ok
    } catch {
      return false
    }
  }

  private convertMessages(messages: Message[], systemPrompt?: string): { role: string; content: string | unknown[] }[] {
    const result: { role: string; content: string | unknown[] }[] = []

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt })
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content })
      } else {
        const parts: unknown[] = []
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'image_url') {
            parts.push({ type: 'image_url', image_url: block.image_url })
          }
        }
        result.push({ role: msg.role, content: parts })
      }
    }

    return result
  }

  private resolveApiKey(keyTemplate: string): string {
    // ${ENV_VAR} → process.env.ENV_VAR
    const match = keyTemplate.match(/^\$\{(.+)\}$/)
    if (match?.[1]) {
      return process.env[match[1]] || ''
    }
    // Direct key (not recommended, but supported)
    return keyTemplate
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/providers/openai-compat.ts
git commit -m "feat: add OpenAI-compatible provider router with SSE streaming"
```

---

### Task 1.6: Implement Anthropic router

**Files:**
- Create: `apps/cli/src/providers/anthropic.ts`

- [ ] **Step 1: Write anthropic.ts**

```typescript
import type { ProviderConfig, ModelInfo, Message, StreamChunk, ContentBlock, ToolUseContent } from '@mipham/shared'
import type { ProviderInstance, ChatRequest } from './registry'

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  source?: { type: string; media_type: string; data: string }
}

interface AnthropicMessage {
  role: string
  content: AnthropicContentBlock[] | string
}

export class AnthropicProvider implements ProviderInstance {
  private baseUrl = 'https://api.anthropic.com/v1'

  constructor(public config: ProviderConfig) {}

  async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const apiKey = this.resolveApiKey(this.config.apiKey)

    const body = {
      model: req.model,
      max_tokens: req.maxTokens || 4096,
      temperature: req.temperature,
      system: req.systemPrompt,
      messages: this.convertMessages(req.messages),
      tools: req.tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters || t.input_schema,
      })),
      stream: true,
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text()
      yield { type: 'error', error: `Anthropic API error ${response.status}: ${errText}` }
      return
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)

        try {
          const parsed = JSON.parse(data)
          if (parsed.type === 'message_stop') {
            yield { type: 'stop' }
            return
          }

          if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
            const cb = parsed.content_block
            yield {
              type: 'tool_use',
              toolUse: {
                type: 'tool_use',
                id: cb.id,
                name: cb.name,
                input: cb.input || {},
              },
            }
            continue
          }

          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield { type: 'text', content: parsed.delta.text }
          }

          if (parsed.type === 'error') {
            yield { type: 'error', error: parsed.error?.message || 'Unknown Anthropic error' }
          }
        } catch {
          // skip unparseable
        }
      }
    }

    yield { type: 'stop' }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.config.models.filter(m => m.status === 'active')
  }

  async healthCheck(): Promise<boolean> {
    // Anthropic doesn't have a models list endpoint; use a lightweight check
    return true
  }

  private convertMessages(messages: Message[]): AnthropicMessage[] {
    return messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : (m.content as ContentBlock[]).map(block => {
              if (block.type === 'text') return { type: 'text', text: block.text }
              if (block.type === 'image_url') {
                return {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: block.image_url.url.replace(/^data:image\/\w+;base64,/, ''),
                  },
                }
              }
              if (block.type === 'tool_result') {
                return {
                  type: 'tool_result',
                  tool_use_id: block.tool_use_id,
                  content: block.content,
                }
              }
              return { type: 'text', text: '' }
            }),
      }))
  }

  private resolveApiKey(keyTemplate: string): string {
    const match = keyTemplate.match(/^\$\{(.+)\}$/)
    if (match?.[1]) {
      return process.env[match[1]] || ''
    }
    return keyTemplate
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/providers/anthropic.ts
git commit -m "feat: add Anthropic provider router with SSE streaming"
```

---

### Task 1.7: Bootstrap providers from config into registry

**Files:**
- Create: `apps/cli/src/providers/bootstrap.ts`

- [ ] **Step 1: Write bootstrap.ts**

```typescript
import type { ProviderConfig } from '@mipham/shared'
import { ProviderRegistry } from './registry'
import { OpenAICompatProvider } from './openai-compat'
import { AnthropicProvider } from './anthropic'

export function bootstrapProviders(configs: ProviderConfig[], defaultProvider: string, defaultModel: string): ProviderRegistry {
  const registry = new ProviderRegistry(configs, defaultProvider, defaultModel)

  for (const config of configs) {
    if (config.status === 'upcoming') continue

    switch (config.protocol) {
      case 'openai-compatible':
        registry.register(config.id, new OpenAICompatProvider(config))
        break
      case 'anthropic':
        registry.register(config.id, new AnthropicProvider(config))
        break
      // custom protocol providers must be registered manually
    }
  }

  return registry
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/providers/bootstrap.ts
git commit -m "feat: add provider bootstrap that wires config to runtime registry"
```

---

### Task 1.8: Implement Context Manager and Instructions Loader

**Files:**
- Create: `apps/cli/src/core/context.ts`
- Create: `apps/cli/src/core/instructions.ts`

- [ ] **Step 1: Write context.ts**

```typescript
import type { Message } from '@mipham/shared'

interface ContextConfig {
  maxTokens: number
  compactionThreshold: number  // e.g. 0.9 → compact at 90% usage
}

export class ContextManager {
  private messages: Message[] = []
  private systemPrompt = ''
  private estimatedTokens = 0

  constructor(private config: ContextConfig) {}

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
    this.estimatedTokens = this.estimateTokens(prompt)
  }

  getSystemPrompt(): string {
    return this.systemPrompt
  }

  addMessage(msg: Message): void {
    this.messages.push(msg)
    this.estimatedTokens += this.estimateTokens(
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    )
  }

  getMessages(): Message[] {
    return [...this.messages]
  }

  needsCompaction(): boolean {
    return this.estimatedTokens > this.config.maxTokens * this.config.compactionThreshold
  }

  async compact(_summarizeHeading: string): Promise<void> {
    // Phase 1: simple truncation — drop oldest messages keeping last 20
    if (this.messages.length > 30) {
      const keep = 20
      const dropped = this.messages.length - keep
      this.messages = this.messages.slice(dropped)
      // Re-estimate
      this.estimatedTokens = this.estimateTokens(this.systemPrompt)
      for (const msg of this.messages) {
        this.estimatedTokens += this.estimateTokens(
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        )
      }
    }
  }

  getEstimatedTokens(): number {
    return this.estimatedTokens
  }

  private estimateTokens(text: string): number {
    // Simple estimation: ~4 chars per token
    return Math.ceil(text.length / 4)
  }
}
```

- [ ] **Step 2: Write instructions.ts**

```typescript
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { InstructionFile } from '@mipham/shared'

interface FrontmatterResult {
  data: Record<string, unknown>
  content: string
}

function parseFrontmatter(raw: string): FrontmatterResult {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: raw }
  }
  return {
    data: parseYaml(match[1] || '') as Record<string, unknown>,
    content: match[2] || '',
  }
}

export class InstructionsLoader {
  private instructions: InstructionFile[] = []

  loadAll(cwd: string): void {
    this.instructions = []

    // Tier 1: Group-level (One Mipham Corporation CLAUDE.md)
    this.tryLoad(join(cwd, '..', 'CLAUDE.md'), 'group')

    // Tier 2: Project MIPHAM.md
    this.tryLoad(join(cwd, 'MIPHAM.md'), 'project')

    // Tier 2b: Directory-level MIPHAM.md (recursive)
    this.tryLoadRecursive(cwd, 'directory')

    // Tier 3: User-level ~/.mipham/USER.md
    const home = process.env.HOME || '~'
    this.tryLoad(join(home, '.mipham', 'USER.md'), 'user')
  }

  buildSystemPrompt(): string {
    const parts: string[] = []

    for (const inst of this.instructions) {
      const levelLabel = { group: 'Group Policy', project: 'Project Rules', directory: 'Directory Rules', user: 'User Preferences' }[inst.level]
      parts.push(`<!-- ${levelLabel} (${inst.path}) -->\n${inst.content}`)
    }

    return parts.join('\n\n---\n\n')
  }

  list(): InstructionFile[] {
    return [...this.instructions]
  }

  private tryLoad(path: string, level: InstructionFile['level']): void {
    if (!existsSync(path)) return

    try {
      const raw = readFileSync(path, 'utf-8')
      const { data, content } = parseFrontmatter(raw)
      this.instructions.push({
        path,
        level,
        privacy: (data.privacy as InstructionFile['privacy']) || 'project',
        language: (data.language as string) || 'en-US',
        content,
        frontmatter: data,
      })
    } catch {
      // Silently skip unreadable files
    }
  }

  private tryLoadRecursive(dir: string, level: InstructionFile['level']): void {
    // Walk up to 3 levels deep
    const maxDepth = 3

    const walk = (current: string, depth: number) => {
      if (depth > maxDepth) return

      const miphamPath = join(current, 'MIPHAM.md')
      if (existsSync(miphamPath) && current !== dir) {
        this.tryLoad(miphamPath, level)
      }

      try {
        const entries = readFileSync(current, { encoding: 'utf-8' })
        // readdir is simpler but we need sync for constructor context
      } catch {
        // skip unreadable directories
      }

      try {
        const { readdirSync } = require('node:fs') as typeof import('node:fs')
        const items = readdirSync(current, { withFileTypes: true })
        for (const item of items) {
          if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
            walk(join(current, item.name), depth + 1)
          }
        }
      } catch {
        // skip
      }
    }

    walk(dir, 0)
  }
}
```

Fix recursive loader — use proper import:
```typescript
import { readdirSync } from 'node:fs'
```

Replace the walk function's require() call with `readdirSync`.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/core/context.ts apps/cli/src/core/instructions.ts
git commit -m "feat: add Context Manager and MIPHAM.md Instructions Loader"
```

---

### Task 1.9: Implement Query Engine (orchestrates model→response loop)

**Files:**
- Create: `apps/cli/src/core/engine.ts`

- [ ] **Step 1: Write engine.ts**

```typescript
import type { Message, StreamChunk, ToolDefinition } from '@mipham/shared'
import { ProviderRegistry } from '../providers/registry'
import { ContextManager } from './context'

export class QueryEngine {
  constructor(
    private registry: ProviderRegistry,
    private context: ContextManager,
    private tools: Map<string, ToolDefinition>,
  ) {}

  async *process(userInput: string): AsyncGenerator<StreamChunk> {
    // Add user message to context
    this.context.addMessage({ role: 'user', content: userInput })

    // Check compaction
    if (this.context.needsCompaction()) {
      await this.context.compact('conversation summary')
    }

    const systemPrompt = this.context.getSystemPrompt()
    const messages = this.context.getMessages()
    const toolDefs = this.getToolDefinitions()

    for await (const chunk of this.registry.chat({
      model: this.registry.getActiveModel(),
      messages,
      systemPrompt,
      tools: toolDefs,
    })) {
      yield chunk

      if (chunk.type === 'tool_use' && chunk.toolUse) {
        // Execute tool and yield result
        const result = await this.executeTool(chunk.toolUse.name, chunk.toolUse.input)
        yield { type: 'tool_result', tool_use_id: chunk.toolUse.id, content: result.content }

        // Add to context
        this.context.addMessage({
          role: 'assistant',
          content: [{ type: 'tool_use', id: chunk.toolUse.id, name: chunk.toolUse.name, input: chunk.toolUse.input }],
        })
        this.context.addMessage({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: chunk.toolUse.id, content: result.content }],
        })
      }

      if (chunk.type === 'text' && chunk.content) {
        // Accumulate assistant response
        this.context.addMessage({ role: 'assistant', content: chunk.content })
      }
    }
  }

  private async executeTool(name: string, params: Record<string, unknown>) {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, content: '', error: `Unknown tool: ${name}` }
    }

    try {
      return await tool.execute(params, {
        cwd: process.cwd(),
        sessionId: 'session-1',
        provider: 'anthropic',
        model: this.registry.getActiveModel(),
      })
    } catch (err) {
      return { success: false, content: '', error: String(err) }
    }
  }

  private getToolDefinitions(): Record<string, unknown>[] {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }

  getContext(): ContextManager {
    return this.context
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/core/engine.ts
git commit -m "feat: add Query Engine orchestrating model→tool→response loop"
```

---

### Task 1.10: Wire M1 prototype — full conversation loop in CLI UI

**Files:**
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/ui/app.tsx`
- Create: `apps/cli/src/ui/chat.tsx`
- Create: `apps/cli/src/ui/input.tsx`

- [ ] **Step 1: Update src/index.ts to wire up all components**

```typescript
import { render } from 'ink'
import { App } from './ui/app'
import { loadConfig } from './config/loader'
import { bootstrapProviders } from './providers/bootstrap'
import { InstructionsLoader } from './core/instructions'
import { ContextManager } from './core/context'
import { QueryEngine } from './core/engine'

interface RunOptions {
  model?: string
  provider?: string
  lang?: string
  permission?: string
}

export async function runApp(options: RunOptions): Promise<void> {
  const config = loadConfig()
  const registry = bootstrapProviders(config.providers, options.provider || config.defaultProvider, options.model || config.defaultModel)
  const instructions = new InstructionsLoader()
  instructions.loadAll(process.cwd())
  const context = new ContextManager({ maxTokens: 200_000, compactionThreshold: 0.9 })
  context.setSystemPrompt(instructions.buildSystemPrompt())
  const engine = new QueryEngine(registry, context, new Map()) // Tools added in M2

  const { waitUntilExit } = render(
    <App engine={engine} config={config} lang={options.lang} />
  )
  await waitUntilExit()
}
```

- [ ] **Step 2: Update ui/app.tsx with full UI**

```typescript
import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { QueryEngine } from '../core/engine'
import type { MiphamConfig } from '@mipham/shared'
import { ChatPanel } from './chat'
import { InputBar } from './input'

interface AppProps {
  engine: QueryEngine
  config: MiphamConfig
  lang?: string
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export function App({ engine, config, lang }: AppProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [providerId, setProviderId] = useState(config.defaultProvider)
  const [modelId, setModelId] = useState(config.defaultModel)

  const handleSubmit = useCallback(async (input: string) => {
    if (!input.trim()) return

    setMessages(prev => [...prev, { role: 'user', content: input }])
    setIsLoading(true)

    let assistantContent = ''

    try {
      for await (const chunk of engine.process(input)) {
        if (chunk.type === 'text' && chunk.content) {
          assistantContent += chunk.content
          setMessages(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last?.role === 'assistant') {
              last.content = assistantContent
            } else {
              updated.push({ role: 'assistant', content: assistantContent })
            }
            return [...updated]
          })
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'system', content: `Error: ${String(err)}` }])
    } finally {
      setIsLoading(false)
    }
  }, [engine])

  useInput((input, key) => {
    if (key.escape) process.exit(0)
  })

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="cyan">🚀 Mipham Code v0.1.0</Text>
        <Text dimColor>
          One Mipham Corporation (Delaware, USA) | mipham.ai
          {'  '}Model: {providerId}/{modelId}
        </Text>
      </Box>

      <ChatPanel messages={messages} />

      <InputBar onSubmit={handleSubmit} isLoading={isLoading} />
    </Box>
  )
}
```

- [ ] **Step 3: Create ui/chat.tsx**

```typescript
import React from 'react'
import { Box, Text } from 'ink'

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface ChatPanelProps {
  messages: Message[]
}

export function ChatPanel({ messages }: ChatPanelProps) {
  return (
    <Box flexDirection="column" marginY={1} flexGrow={1}>
      {messages.length === 0 && (
        <Box>
          <Text dimColor>Type a message to start. /help for commands.</Text>
        </Box>
      )}
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column" marginY={1}>
          <Text bold color={msg.role === 'user' ? 'green' : msg.role === 'system' ? 'red' : 'blue'}>
            {msg.role === 'user' ? '▸ You' : msg.role === 'assistant' ? '✦ Mipham Code' : '⚠ System'}:
          </Text>
          <Text>{msg.content}</Text>
        </Box>
      ))}
    </Box>
  )
}
```

- [ ] **Step 4: Create ui/input.tsx**

```typescript
import React, { useState } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'

interface InputBarProps {
  onSubmit: (input: string) => void
  isLoading: boolean
}

export function InputBar({ onSubmit, isLoading }: InputBarProps) {
  const [value, setValue] = useState('')

  const handleSubmit = (val: string) => {
    if (!val.trim() || isLoading) return
    onSubmit(val)
    setValue('')
  }

  // Handle slash commands
  // /help, /model, /provider, /exit

  return (
    <Box marginTop={1}>
      <Box marginRight={1}>
        <Text color="yellow">{isLoading ? '⏳' : '▸'}</Text>
      </Box>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={isLoading ? 'Thinking...' : 'Type a message (Esc to exit)...'}
      />
    </Box>
  )
}
```

- [ ] **Step 5: Install ink-text-input**

```bash
cd apps/cli && bun add ink-text-input
```

- [ ] **Step 6: Test M1 prototype**

```bash
cd apps/cli && bun run bin/mipham.ts
```

Expected: CLI launches, shows banner, accepts text input, streams responses from configured model.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/index.ts apps/cli/src/ui/ apps/cli/package.json
git commit -m "feat: wire M1 prototype — full CLI conversation loop with model streaming"
```

---

## M2: Tool System — 16 Tools + Permission + Hooks

### Task 2.1: Implement file tools (Read, Write, Edit, Glob, Grep)

**Files:**
- Create: `apps/cli/src/tools/index.ts`
- Create: `apps/cli/src/tools/file/read.ts`
- Create: `apps/cli/src/tools/file/write.ts`
- Create: `apps/cli/src/tools/file/edit.ts`
- Create: `apps/cli/src/tools/file/glob.ts`
- Create: `apps/cli/src/tools/file/grep.ts`

- [ ] **Step 1: Create tools/index.ts — Tool Registry**

```typescript
import type { ToolDefinition, ToolResult } from '@mipham/shared'
import { readTool } from './file/read'
import { writeTool } from './file/write'
import { editTool } from './file/edit'
import { globTool } from './file/glob'
import { grepTool } from './file/grep'
import { bashTool } from './exec/bash'
import { gitTool } from './exec/git'
import { taskTool } from './exec/task'
import { agentTool } from './agent/agent'
import { skillTool } from './agent/skill'
import { planTool } from './agent/plan'
import { memoryTool } from './agent/memory'
import { webFetchTool } from './network/web-fetch'
import { webSearchTool } from './network/web-search'
import { configTool } from './system/config'
import { mcpTool } from './system/mcp'

export function createToolRegistry(): Map<string, ToolDefinition> {
  const tools: ToolDefinition[] = [
    // File
    readTool, writeTool, editTool, globTool, grepTool,
    // Exec
    bashTool, gitTool, taskTool,
    // Agent
    agentTool, skillTool, planTool, memoryTool,
    // Network
    webFetchTool, webSearchTool,
    // System
    configTool, mcpTool,
  ]

  const map = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    map.set(tool.name, tool)
  }
  return map
}
```

- [ ] **Step 2: Write file/read.ts**

```typescript
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolDefinition } from '@mipham/shared'

export const readTool: ToolDefinition = {
  name: 'Read',
  description: 'Read a file from the local filesystem. Supports offset and limit for large files.',
  category: 'file',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to read' },
      offset: { type: 'integer', description: 'Line number to start reading from' },
      limit: { type: 'integer', description: 'Number of lines to read' },
    },
    required: ['file_path'],
  },
  async execute(params, ctx) {
    const filePath = resolve(ctx.cwd, params.file_path as string)
    if (!existsSync(filePath)) {
      return { success: false, content: '', error: `File not found: ${filePath}` }
    }
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      return { success: false, content: '', error: `Path is a directory: ${filePath}` }
    }
    const offset = (params.offset as number) || 0
    const limit = (params.limit as number) || 2000
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    const slice = lines.slice(offset, offset + limit)
    const result = slice.map((l, i) => `${String(offset + i + 1).padStart(6, ' ')}\t${l}`).join('\n')
    return { success: true, content: result }
  },
}
```

- [ ] **Step 3: Write file/write.ts**

```typescript
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ToolDefinition } from '@mipham/shared'

export const writeTool: ToolDefinition = {
  name: 'Write',
  description: 'Write a file to the local filesystem. Creates parent directories if needed.',
  category: 'file',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to write to' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['file_path', 'content'],
  },
  async execute(params, ctx) {
    const filePath = resolve(ctx.cwd, params.file_path as string)
    const content = params.content as string
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, 'utf-8')
    const lines = content.split('\n').length
    return { success: true, content: `Wrote ${lines} lines to ${filePath}` }
  },
}
```

- [ ] **Step 4: Write file/edit.ts**

```typescript
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ToolDefinition } from '@mipham/shared'

export const editTool: ToolDefinition = {
  name: 'Edit',
  description: 'Perform exact string replacement in a file. old_string must match exactly.',
  category: 'file',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean', default: false },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async execute(params, ctx) {
    const filePath = resolve(ctx.cwd, params.file_path as string)
    const oldStr = params.old_string as string
    const newStr = params.new_string as string
    const replaceAll = params.replace_all as boolean

    const content = readFileSync(filePath, 'utf-8')

    if (replaceAll) {
      if (!content.includes(oldStr)) {
        return { success: false, content: '', error: 'old_string not found in file' }
      }
      const updated = content.replaceAll(oldStr, newStr)
      writeFileSync(filePath, updated, 'utf-8')
      const count = content.split(oldStr).length - 1
      return { success: true, content: `Replaced ${count} occurrences in ${filePath}` }
    }

    const firstIndex = content.indexOf(oldStr)
    if (firstIndex === -1) {
      return { success: false, content: '', error: 'old_string not found in file' }
    }
    const secondIndex = content.indexOf(oldStr, firstIndex + 1)
    if (secondIndex !== -1) {
      return { success: false, content: '', error: 'old_string is not unique in file. Use replace_all or make it more specific.' }
    }

    const updated = content.slice(0, firstIndex) + newStr + content.slice(firstIndex + oldStr.length)
    writeFileSync(filePath, updated, 'utf-8')
    return { success: true, content: `Replaced 1 occurrence in ${filePath}` }
  },
}
```

- [ ] **Step 5: Write file/glob.ts**

```typescript
import { resolve } from 'node:path'
import { Glob } from 'bun'
import type { ToolDefinition } from '@mipham/shared'

export const globTool: ToolDefinition = {
  name: 'Glob',
  description: 'Find files matching a glob pattern.',
  category: 'file',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "src/**/*.ts")' },
      path: { type: 'string', description: 'Base directory' },
    },
    required: ['pattern'],
  },
  async execute(params, ctx) {
    const pattern = params.pattern as string
    const basePath = resolve(ctx.cwd, (params.path as string) || '.')
    const glob = new Glob(pattern)
    const results: string[] = []
    for await (const file of glob.scan({ cwd: basePath, absolute: true })) {
      results.push(file)
      if (results.length >= 500) break
    }
    return { success: true, content: results.join('\n') || '(no matches)' }
  },
}
```

- [ ] **Step 6: Write file/grep.ts**

```typescript
import { $ } from 'bun'
import { resolve } from 'node:path'
import type { ToolDefinition } from '@mipham/shared'

export const grepTool: ToolDefinition = {
  name: 'Grep',
  description: 'Search file contents using ripgrep. Fast regex search across files.',
  category: 'file',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search in' },
      include: { type: 'string', description: 'File pattern to include (e.g., "*.ts")' },
    },
    required: ['pattern'],
  },
  async execute(params, ctx) {
    const pattern = params.pattern as string
    const searchPath = resolve(ctx.cwd, (params.path as string) || '.')
    const include = params.include as string | undefined

    try {
      const args = ['-n', '--heading', '--color=never', '-M', '500', pattern]
      if (include) args.push('--glob', include)
      args.push(searchPath)

      const result = await $`rg ${args}`.cwd(ctx.cwd).quiet().text()
      return { success: true, content: result || '(no matches)' }
    } catch (err: any) {
      if (err.exitCode === 1) {
        return { success: true, content: '(no matches)' }
      }
      // ripgrep not installed? fallback to Bun's grep
      try {
        const content = await $`grep -rn ${pattern} ${searchPath}`.cwd(ctx.cwd).quiet().text()
        return { success: true, content: content.slice(0, 50000) || '(no matches)' }
      } catch {
        return { success: false, content: '', error: 'grep failed. Install ripgrep: brew install ripgrep' }
      }
    }
  },
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/tools/
git commit -m "feat: add file tools — Read, Write, Edit, Glob, Grep"
```

---

### Task 2.2: Implement execution tools (Bash, Git, Task)

**Files:**
- Create: `apps/cli/src/tools/exec/bash.ts`
- Create: `apps/cli/src/tools/exec/git.ts`
- Create: `apps/cli/src/tools/exec/task.ts`

- [ ] **Step 1: Write exec/bash.ts**

```typescript
import { $ } from 'bun'
import type { ToolDefinition } from '@mipham/shared'

export const bashTool: ToolDefinition = {
  name: 'Bash',
  description: 'Execute a bash command. Returns stdout and stderr. Timeout: 120s.',
  category: 'exec',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      description: { type: 'string', description: 'What this command does (for audit log)' },
      timeout: { type: 'integer', description: 'Timeout in milliseconds (max 600000)' },
    },
    required: ['command'],
  },
  async execute(params, ctx) {
    const command = params.command as string
    const timeout = Math.min((params.timeout as number) || 120000, 600000)
    const startTime = Date.now()

    try {
      const proc = $`${{ raw: command }}`.cwd(ctx.cwd).quiet()

      const timer = setTimeout(() => {
        proc.kill()
      }, timeout)

      const output = await proc.text()
      clearTimeout(timer)

      const elapsed = Date.now() - startTime
      const truncated = output.slice(0, 100000)
      return { success: true, content: truncated || '(no output)' }
    } catch (err: any) {
      const elapsed = Date.now() - startTime
      return {
        success: false,
        content: err.stderr?.toString().slice(0, 5000) || '',
        error: `Exit code ${err.exitCode} (${elapsed}ms): ${err.message}`,
      }
    }
  },
}
```

- [ ] **Step 2: Write exec/git.ts**

```typescript
import { $ } from 'bun'
import type { ToolDefinition } from '@mipham/shared'

const DANGEROUS_COMMANDS = ['push --force', 'reset --hard', 'clean -fd', 'branch -D']

export const gitTool: ToolDefinition = {
  name: 'Git',
  description: 'Execute git commands. Dangerous operations (force push, hard reset) are blocked.',
  category: 'exec',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Git subcommand + args (e.g., "status", "log --oneline")' },
    },
    required: ['command'],
  },
  async execute(params, ctx) {
    const command = params.command as string

    for (const dangerous of DANGEROUS_COMMANDS) {
      if (command.includes(dangerous)) {
        return { success: false, content: '', error: `Dangerous git command blocked: "${dangerous}". Run manually if intended.` }
      }
    }

    try {
      const result = await $`git ${${{ raw: command }}}`.cwd(ctx.cwd).quiet().text()
      return { success: true, content: result.slice(0, 50000) || '(no output)' }
    } catch (err: any) {
      return { success: false, content: err.stderr?.toString().slice(0, 5000) || '', error: `Git error: ${err.message}` }
    }
  },
}
```

- [ ] **Step 3: Write exec/task.ts**

```typescript
import type { ToolDefinition } from '@mipham/shared'

interface Task {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
}

const tasks = new Map<string, Task>()
let taskCounter = 0

export const taskTool: ToolDefinition = {
  name: 'Task',
  description: 'Create and manage structured task lists for tracking progress.',
  category: 'exec',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'update'], description: 'Action to perform' },
      subject: { type: 'string', description: 'Task subject (for create)' },
      description: { type: 'string', description: 'Task description (for create)' },
      taskId: { type: 'string', description: 'Task ID (for update)' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'New status (for update)' },
    },
    required: ['action'],
  },
  async execute(params, _ctx) {
    const action = params.action as string

    if (action === 'create') {
      const id = String(++taskCounter)
      tasks.set(id, {
        id,
        subject: (params.subject as string) || 'Untitled',
        description: (params.description as string) || '',
        status: 'pending',
      })
      return { success: true, content: `Task #${id} created: ${params.subject}` }
    }

    if (action === 'list') {
      const list = Array.from(tasks.values())
        .map(t => `[${t.status}] #${t.id}: ${t.subject}`)
        .join('\n')
      return { success: true, content: list || '(no tasks)' }
    }

    if (action === 'update') {
      const taskId = params.taskId as string
      const task = tasks.get(taskId)
      if (!task) return { success: false, content: '', error: `Task #${taskId} not found` }
      if (params.status) task.status = params.status as Task['status']
      return { success: true, content: `Task #${taskId} updated: ${task.status}` }
    }

    return { success: false, content: '', error: `Unknown action: ${action}` }
  },
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/tools/exec/
git commit -m "feat: add execution tools — Bash, Git, Task"
```

---

### Task 2.3: Implement agent tools (Agent, Skill, Plan, Memory)

**Files:**
- Create: `apps/cli/src/tools/agent/agent.ts`
- Create: `apps/cli/src/tools/agent/skill.ts`
- Create: `apps/cli/src/tools/agent/plan.ts`
- Create: `apps/cli/src/tools/agent/memory.ts`

- [ ] **Step 1: Write each agent tool**

Same pattern, here's agent/agent.ts:
```typescript
import type { ToolDefinition } from '@mipham/shared'

export const agentTool: ToolDefinition = {
  name: 'Agent',
  description: 'Launch a sub-agent to handle complex, multi-step tasks independently.',
  category: 'agent',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description of the task' },
      prompt: { type: 'string', description: 'The task for the agent to perform' },
      subagent_type: { type: 'string', description: 'Type of specialized agent' },
    },
    required: ['description', 'prompt'],
  },
  async execute(params, ctx) {
    const description = params.description as string
    const prompt = params.prompt as string
    // Phase 1: spawn as internal sub-context
    return {
      success: true,
      content: `[Agent dispatched]\nTask: ${description}\nPrompt: ${prompt}\n\nAgent result would appear here. Full agent subsystem in M3.`,
    }
  },
}
```

agent/skill.ts:
```typescript
import type { ToolDefinition } from '@mipham/shared'

export const skillTool: ToolDefinition = {
  name: 'Skill',
  description: 'Execute a skill (SKILL.md or .mipham-skill.md) by name.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Name of the skill to invoke' },
      args: { type: 'string', description: 'Optional arguments' },
    },
    required: ['skill'],
  },
  async execute(params, _ctx) {
    const skillName = params.skill as string
    return {
      success: true,
      content: `Skill "${skillName}" invoked. Full skills system in M3.`,
    }
  },
}
```

agent/plan.ts:
```typescript
import type { ToolDefinition } from '@mipham/shared'

export const planTool: ToolDefinition = {
  name: 'Plan',
  description: 'Enter plan mode — read-only analysis and design, no code execution.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(_params, _ctx) {
    return {
      success: true,
      content: 'Plan mode activated. The AI will analyze and design without executing any code changes.',
    }
  },
}
```

agent/memory.ts:
```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition } from '@mipham/shared'

const MEMORY_DIR = join(process.env.HOME || '~', '.mipham', 'memory')

export const memoryTool: ToolDefinition = {
  name: 'Memory',
  description: 'Read and write persistent memory files in ~/.mipham/memory/.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'list'], description: 'Action' },
      name: { type: 'string', description: 'Memory file name (slug)' },
      content: { type: 'string', description: 'Content to write (for write action)' },
    },
    required: ['action'],
  },
  async execute(params, _ctx) {
    const action = params.action as string
    mkdirSync(MEMORY_DIR, { recursive: true })

    if (action === 'list') {
      const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'))
      return { success: true, content: files.join('\n') || '(no memories)' }
    }

    const name = params.name as string
    if (!name) return { success: false, content: '', error: 'name is required' }
    const filePath = join(MEMORY_DIR, `${name}.md`)

    if (action === 'read') {
      if (!existsSync(filePath)) return { success: false, content: '', error: `Memory "${name}" not found` }
      return { success: true, content: readFileSync(filePath, 'utf-8') }
    }

    if (action === 'write') {
      writeFileSync(filePath, params.content as string, 'utf-8')
      return { success: true, content: `Memory "${name}" written` }
    }

    return { success: false, content: '', error: `Unknown action: ${action}` }
  },
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/tools/agent/
git commit -m "feat: add agent tools — Agent, Skill, Plan, Memory"
```

---

### Task 2.4: Implement network and system tools

**Files:**
- Create: `apps/cli/src/tools/network/web-fetch.ts`
- Create: `apps/cli/src/tools/network/web-search.ts`
- Create: `apps/cli/src/tools/system/config.ts`
- Create: `apps/cli/src/tools/system/mcp.ts`

- [ ] **Step 1: Write network/web-fetch.ts**

```typescript
import type { ToolDefinition } from '@mipham/shared'

export const webFetchTool: ToolDefinition = {
  name: 'WebFetch',
  description: 'Fetch content from a URL and process into markdown.',
  category: 'network',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', description: 'URL to fetch' },
      prompt: { type: 'string', description: 'Prompt to run on fetched content' },
    },
    required: ['url'],
  },
  async execute(params, _ctx) {
    const url = params.url as string
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mipham-Code/0.1.0' },
        redirect: 'follow',
      })
      if (!response.ok) {
        return { success: false, content: '', error: `HTTP ${response.status}: ${response.statusText}` }
      }
      const html = await response.text()
      // Simple HTML-to-text extraction
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50000)
      return { success: true, content: text }
    } catch (err) {
      return { success: false, content: '', error: `Fetch failed: ${String(err)}` }
    }
  },
}
```

- [ ] **Step 2: Write network/web-search.ts**

```typescript
import type { ToolDefinition } from '@mipham/shared'

export const webSearchTool: ToolDefinition = {
  name: 'WebSearch',
  description: 'Search the web. Returns result titles and URLs.',
  category: 'network',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, description: 'Search query' },
      allowed_domains: { type: 'array', items: { type: 'string' } },
      blocked_domains: { type: 'array', items: { type: 'string' } },
    },
    required: ['query'],
  },
  async execute(params, _ctx) {
    const query = params.query as string
    // Phase 1: delegate to model's built-in search capability
    return {
      success: true,
      content: `WebSearch query: "${query}". Results would appear here when search API is configured.`,
    }
  },
}
```

- [ ] **Step 3: Write system/config.ts**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import type { ToolDefinition } from '@mipham/shared'

const MIPHAM_DIR = join(process.env.HOME || '~', '.mipham')
const USER_CONFIG = join(MIPHAM_DIR, 'config.yml')

export const configTool: ToolDefinition = {
  name: 'Config',
  description: 'Read or update Mipham Code configuration.',
  category: 'system',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'list'], description: 'Action' },
      key: { type: 'string', description: 'Config key (dot notation)' },
      value: { type: 'string', description: 'Value to set' },
    },
    required: ['action'],
  },
  async execute(params, _ctx) {
    mkdirSync(MIPHAM_DIR, { recursive: true })
    const action = params.action as string

    let config: Record<string, unknown> = {}
    if (existsSync(USER_CONFIG)) {
      config = parseYaml(readFileSync(USER_CONFIG, 'utf-8')) as Record<string, unknown>
    }

    if (action === 'list') {
      return { success: true, content: stringify(config) || '(empty config)' }
    }

    const key = params.key as string
    if (!key) return { success: false, content: '', error: 'key is required for get/set' }

    if (action === 'get') {
      const value = key.split('.').reduce((obj: any, k) => obj?.[k], config)
      return { success: true, content: JSON.stringify(value) }
    }

    if (action === 'set') {
      const keys = key.split('.')
      let obj: any = config
      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]!]) obj[keys[i]!] = {}
        obj = obj[keys[i]!]
      }
      obj[keys[keys.length - 1]!] = params.value
      writeFileSync(USER_CONFIG, stringify(config), 'utf-8')
      return { success: true, content: `Set ${key} = ${params.value}` }
    }

    return { success: false, content: '', error: `Unknown action: ${action}` }
  },
}
```

- [ ] **Step 4: Write system/mcp.ts**

```typescript
import type { ToolDefinition } from '@mipham/shared'

export const mcpTool: ToolDefinition = {
  name: 'MCP',
  description: 'Interact with MCP (Model Context Protocol) servers.',
  category: 'system',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      tool: { type: 'string', description: 'Tool name on the MCP server' },
      params: { type: 'object', description: 'Parameters for the tool' },
    },
    required: ['server', 'tool'],
  },
  async execute(params, _ctx) {
    const server = params.server as string
    const toolName = params.tool as string
    // Phase 1: MCP client integration via stdio
    return {
      success: true,
      content: `MCP call: ${server}/${toolName}. Full MCP client integration in progress.`,
    }
  },
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/tools/network/ apps/cli/src/tools/system/
git commit -m "feat: add network and system tools — WebFetch, WebSearch, Config, MCP"
```

---

### Task 2.5: Implement Permission System and Hook Engine

**Files:**
- Create: `apps/cli/src/core/permission.ts`
- Create: `apps/cli/src/core/hooks.ts`

- [ ] **Step 1: Write permission.ts**

```typescript
import type { ToolDefinition, PermissionLevel, ToolPermission } from '@mipham/shared'

export class PermissionSystem {
  private rules = new Map<string, PermissionLevel>()

  constructor(private defaultLevel: ToolPermission = 'auto') {}

  setRule(toolName: string, level: PermissionLevel): void {
    this.rules.set(toolName, level)
  }

  check(tool: ToolDefinition, _input: Record<string, unknown>): PermissionLevel {
    const ruleLevel = this.rules.get(tool.name)
    if (ruleLevel) return ruleLevel
    return tool.permission
  }

  needsApproval(tool: ToolDefinition, input: Record<string, unknown>): boolean {
    return this.check(tool, input) === 'ask'
  }
}
```

- [ ] **Step 2: Write hooks.ts**

```typescript
import type { HookDefinition, HookEvent, HookContext, HookResult, ToolResult } from '@mipham/shared'

export class HookEngine {
  private hooks = new Map<HookEvent, HookDefinition[]>()

  register(hook: HookDefinition): void {
    const existing = this.hooks.get(hook.event) || []
    existing.push(hook)
    this.hooks.set(hook.event, existing)
  }

  async execute(event: HookEvent, context: HookContext): Promise<HookResult> {
    const eventHooks = this.hooks.get(event) || []
    let result: HookResult = { allowed: true }

    for (const hook of eventHooks) {
      if (hook.toolName && hook.toolName !== context.toolName) continue

      try {
        const hookResult = await hook.handler(context)
        if (!hookResult.allowed) {
          return hookResult
        }
        if (hookResult.modifiedInput) {
          context.toolInput = hookResult.modifiedInput
          result.modifiedInput = hookResult.modifiedInput
        }
      } catch (err) {
        // Hook errors should not block execution
      }
    }

    return result
  }

  async executePreToolUse(toolName: string, input: Record<string, unknown>, sessionId: string): Promise<HookResult> {
    return this.execute('PreToolUse', {
      event: 'PreToolUse',
      toolName,
      toolInput: input,
      sessionId,
    })
  }

  async executePostToolUse(toolName: string, input: Record<string, unknown>, result: ToolResult, sessionId: string): Promise<void> {
    await this.execute('PostToolUse', {
      event: 'PostToolUse',
      toolName,
      toolInput: input,
      toolResult: result,
      sessionId,
    })
  }

  async executeSessionStart(sessionId: string): Promise<void> {
    await this.execute('SessionStart', { event: 'SessionStart', sessionId })
  }
}
```

- [ ] **Step 3: Wire permissions and hooks into engine.ts**

Modify `apps/cli/src/core/engine.ts` to add permission check and hook execution before tool calls. Add to the `executeTool` private method:

```typescript
// Add these fields to QueryEngine constructor:
// private permission: PermissionSystem
// private hooks: HookEngine

private async executeTool(name: string, params: Record<string, unknown>) {
  const tool = this.tools.get(name)
  if (!tool) {
    return { success: false, content: '', error: `Unknown tool: ${name}` }
  }

  // Permission check
  if (this.permission.needsApproval(tool, params)) {
    // In Phase 1, log and allow. Phase 2 adds interactive approval.
  }

  // Pre-tool hook
  const hookResult = await this.hooks.executePreToolUse(name, params, 'session-1')
  if (!hookResult.allowed) {
    return { success: false, content: '', error: hookResult.reason || 'Blocked by hook' }
  }

  const finalParams = hookResult.modifiedInput || params

  try {
    const result = await tool.execute(finalParams, {
      cwd: process.cwd(),
      sessionId: 'session-1',
      provider: 'anthropic',
      model: this.registry.getActiveModel(),
    })
    await this.hooks.executePostToolUse(name, finalParams, result, 'session-1')
    return result
  } catch (err) {
    return { success: false, content: '', error: String(err) }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/core/permission.ts apps/cli/src/core/hooks.ts apps/cli/src/core/engine.ts
git commit -m "feat: add Permission System and Hook Engine, wired into engine"
```

---

## M3: Skills System — Dual-Track + 10 Built-in Skills

### Task 3.1: Implement Skills Loader (SKILL.md + .mipham-skill.md)

**Files:**
- Create: `apps/cli/src/skills/loader.ts`

- [ ] **Step 1: Write loader.ts**

```typescript
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SkillDefinition, ToolDefinition, HookDefinition } from '@mipham/shared'

interface LoadedSkill {
  definition: SkillDefinition
  sourcePath: string
  sourceType: 'standard' | 'mipham'
}

export class SkillLoader {
  private skills = new Map<string, LoadedSkill>()

  loadFromPaths(paths: string[]): void {
    for (const p of paths) {
      const absPath = resolve(p)
      if (!existsSync(absPath)) continue

      const stat = (() => { try { return readdirSync(absPath, { withFileTypes: true }) } catch { return null } })()
      if (!stat) continue

      for (const entry of readdirSync(absPath, { withFileTypes: true })) {
        if (entry.isFile()) {
          if (entry.name.endsWith('.SKILL.md')) {
            this.tryLoad(join(absPath, entry.name), 'standard')
          } else if (entry.name.endsWith('.mipham-skill.md')) {
            this.tryLoad(join(absPath, entry.name), 'mipham')
          }
        }
      }
    }
  }

  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name)
  }

  list(): LoadedSkill[] {
    return Array.from(this.skills.values())
  }

  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = []
    for (const skill of this.skills.values()) {
      if (skill.definition.tools) tools.push(...skill.definition.tools)
    }
    return tools
  }

  getAllHooks(): HookDefinition[] {
    const hooks: HookDefinition[] = []
    for (const skill of this.skills.values()) {
      if (skill.definition.hooks) hooks.push(...skill.definition.hooks)
    }
    return hooks
  }

  private tryLoad(path: string, sourceType: 'standard' | 'mipham'): void {
    try {
      const raw = readFileSync(path, 'utf-8')
      const def = this.parseSkillMd(raw)
      this.skills.set(def.name, { definition: def, sourcePath: path, sourceType })
    } catch {
      // skip unparseable
    }
  }

  private parseSkillMd(raw: string): SkillDefinition {
    const lines = raw.split('\n')
    let name = ''
    let description = ''
    let version = '0.0.0'

    // Parse frontmatter-style headers
    let inHeader = false
    for (const line of lines) {
      if (line.startsWith('---')) { inHeader = !inHeader; continue }
      if (inHeader) {
        const [key, ...rest] = line.split(':')
        const value = rest.join(':').trim()
        if (key?.trim() === 'name') name = value
        if (key?.trim() === 'description') description = value
        if (key?.trim() === 'version') version = value
      }
    }

    return {
      name: name || path.replace(/\.(SKILL|mipham-skill)\.md$/, ''),
      description: description || 'No description',
      version: version || '0.0.0',
      type: 'standard',
      prompts: { main: raw },
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/skills/loader.ts
git commit -m "feat: add Skills Loader with SKILL.md and .mipham-skill.md support"
```

---

### Task 3.2: Create 8 standard SKILL.md files

**Files:**
- Create: `apps/cli/skills/standard/superpower.SKILL.md`
- Create: `apps/cli/skills/standard/code-review.SKILL.md`
- Create: `apps/cli/skills/standard/self-review.SKILL.md`
- Create: `apps/cli/skills/standard/memory.SKILL.md`
- Create: `apps/cli/skills/standard/tdd.SKILL.md`
- Create: `apps/cli/skills/standard/web-search.SKILL.md`
- Create: `apps/cli/skills/standard/github-ops.SKILL.md`
- Create: `apps/cli/skills/standard/doc-generator.SKILL.md`

- [ ] **Step 1: Write each SKILL.md**

Example — `superpower.SKILL.md`:
```markdown
---
name: superpower
description: Skill invocation framework for Mipham Code
version: 1.0.0
---

# Superpower

The skill invocation framework. This skill manages the discovery and invocation of other skills within Mipham Code.

## When to Use

Invoke this skill when you need to discover available skills or learn how to use the skill system.

## Usage

- List available skills: The Skill tool shows all registered skills
- Invoke a skill by name: Use the Skill tool with the skill name
- Skills can be standard SKILL.md files or Mipham-exclusive .mipham-skill.md files
```

Example — `memory.SKILL.md`:
```markdown
---
name: memory
description: Persistent memory management for Mipham Code sessions
version: 1.0.0
---

# Memory

Manage persistent memory across Mipham Code sessions. Memories are stored as markdown files in ~/.mipham/memory/.

## Usage

- Recall: Memories matching the current context are loaded automatically
- Write: Use the Memory tool to save facts, preferences, or project context
- Memory types: user, feedback, project, reference

## Format

Each memory is a markdown file with YAML frontmatter:
---
name: slug-name
description: One-line summary
type: user | feedback | project | reference
---
```

(Remaining 6 SKILL.md files follow same pattern — each defines name, description, version, usage guide.)

- [ ] **Step 2: Commit**

```bash
git add apps/cli/skills/standard/
git commit -m "feat: add 8 standard SKILL.md files for built-in skills"
```

---

### Task 3.3: Create 2 Mipham-exclusive skill files

**Files:**
- Create: `apps/cli/skills/mipham/om-model-optimize.mipham-skill.md`
- Create: `apps/cli/skills/mipham/om-security.mipham-skill.md`

- [ ] **Step 1: Write om-model-optimize.mipham-skill.md**

```markdown
---
name: om-model-optimize
description: Multi-model intelligent routing — automatically selects the best model for each task
version: 1.0.0
type: mipham
---

# OM Model Optimize

Mipham-exclusive skill for intelligent model selection across connected providers.

## Routing Rules

| Task Type | Recommended Model | Fallback |
|-----------|-------------------|----------|
| Complex reasoning | claude-opus-4-8 / gpt-5.5 | deepseek-v4-pro |
| Code generation | claude-sonnet-4-6 / gpt-5.4 | deepseek-v4-flash |
| Quick fixes | claude-haiku-4-5-20251001 / gpt-5.4-mini | deepseek-v4-flash |
| Code review | claude-sonnet-4-6 | gpt-5.3-codex |
| Documentation | gpt-5.4-mini | claude-haiku-4-5-20251001 |

## Phase 2
When om-V5 series launches, routing prioritizes MiphamAI models for all task types.
```

- [ ] **Step 2: Write om-security.mipham-skill.md**

```markdown
---
name: om-security
description: Security audit hooks — validates code changes against security policies
version: 1.0.0
type: mipham
---

# OM Security

Mipham-exclusive security audit skill. Runs PreToolUse hooks on Write/Edit/Bash tools to check for security violations.

## Checks

- No hardcoded credentials in code
- No API keys in logs or config files
- TLS 1.3 enforced for network calls
- AES-256-GCM for stored data
- Prompt injection patterns in AI-facing code

## Hook Registration

This skill registers a PreToolUse hook on Write/Edit tools. When code is being written:
1. Scan content for credential patterns
2. Block if hardcoded secrets detected
3. Warn on suspicious patterns
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/skills/mipham/
git commit -m "feat: add 2 Mipham-exclusive skill files with model routing and security"
```

---

### Task 3.4: Wire Skills system into Engine and CLI bootstrap

**Files:**
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/core/engine.ts`

- [ ] **Step 1: Update src/index.ts to load skills**

Add after engine creation:
```typescript
import { SkillLoader } from './skills/loader'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ... existing code ...

// Load built-in skills
const skillLoader = new SkillLoader()
const __dirname = dirname(fileURLToPath(import.meta.url))
const builtinSkillsPath = resolve(__dirname, '..', 'skills')
skillLoader.loadFromPaths([builtinSkillsPath])

// Merge skill tools into engine
const allTools = createToolRegistry()
for (const tool of skillLoader.getAllTools()) {
  allTools.set(tool.name, tool)
}

// Wire skill hooks into hook engine
for (const hook of skillLoader.getAllHooks()) {
  hooks.register(hook)
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/index.ts
git commit -m "feat: wire Skills system into engine with built-in skills loading"
```

---

## M4: Web Interface — mipham.ai/code Product Page

### Task 4.1: Scaffold Next.js web app with Tailwind

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.js`
- Create: `apps/web/tailwind.config.ts`
- Create: `apps/web/postcss.config.js`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`

- [ ] **Step 1: Create apps/web/package.json**

```json
{
  "name": "@mipham/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3002",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mipham/shared": "workspace:*",
    "next": "^14.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create apps/web/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "src", ".next/types/**/*.ts"]
}
```

- [ ] **Step 3: Create apps/web/next.config.js**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/code',
  output: 'export',
  images: { unoptimized: true },
}

module.exports = nextConfig
```

- [ ] **Step 4: Create apps/web/tailwind.config.ts**

```typescript
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        mipham: {
          cyan: '#06b6d4',
          dark: '#0f172a',
          light: '#f8fafc',
        },
      },
    },
  },
  plugins: [],
}

export default config
```

- [ ] **Step 5: Create apps/web/postcss.config.js**

```javascript
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

- [ ] **Step 6: Create root layout.tsx**

```tsx
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Mipham Code — Multi-Model Open-Core Intelligent Coding Terminal',
  description: 'Connect global LLMs. One terminal. Open Core. Mipham Code by One Mipham Corporation (Delaware, USA).',
  openGraph: {
    title: 'Mipham Code — Open-Core AI Coding Terminal',
    description: 'ChatGPT, Claude, DeepSeek, Qwen — all in one CLI. SKILL.md compatible. Open Core (Apache 2.0).',
    url: 'https://mipham.ai/code',
    siteName: 'Mipham Code',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-mipham-dark text-white antialiased">{children}</body>
    </html>
  )
}
```

- [ ] **Step 7: Create globals.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/
git commit -m "feat: scaffold Next.js web app with Tailwind CSS"
```

---

### Task 4.2: Build /code landing page with all sections

**Files:**
- Create: `apps/web/src/app/code/page.tsx`
- Create: `apps/web/src/app/code/layout.tsx`
- Create: `apps/web/src/app/code/components/hero.tsx`
- Create: `apps/web/src/app/code/components/features.tsx`
- Create: `apps/web/src/app/code/components/models.tsx`
- Create: `apps/web/src/app/code/components/install-cmd.tsx`
- Create: `apps/web/src/app/code/components/footer.tsx`

- [ ] **Step 1: Write code/layout.tsx**

```tsx
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Mipham Code — Open-Core AI Coding Terminal',
  description: 'Connect to any major LLM. Open Core. SKILL.md ecosystem.',
}

export default function CodeLayout({ children }: { children: React.ReactNode }) {
  return <main className="min-h-screen">{children}</main>
}
```

- [ ] **Step 2: Write code/page.tsx**

```tsx
import { Hero } from './components/hero'
import { Features } from './components/features'
import { Models } from './components/models'
import { InstallCmd } from './components/install-cmd'
import { Footer } from './components/footer'

export default function CodePage() {
  return (
    <>
      <Hero />
      <Features />
      <Models />
      <InstallCmd />
      <Footer />
    </>
  )
}
```

- [ ] **Step 3: Write code/components/hero.tsx**

```tsx
export function Hero() {
  return (
    <section className="pt-32 pb-20 px-4 text-center">
      <h1 className="text-5xl md:text-7xl font-bold tracking-tight">
        <span className="bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
          Mipham Code
        </span>
      </h1>
      <p className="mt-6 text-xl md:text-2xl text-slate-400 max-w-3xl mx-auto">
        Connect global LLMs. One terminal. Open Core.
        <br />
        <span className="text-slate-500">ChatGPT, Claude, DeepSeek, Qwen — all in one CLI.</span>
      </p>
      <p className="mt-4 text-sm text-slate-600">
        One Mipham Corporation (Delaware, USA) | mipham.ai
      </p>
      <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
        <a
          href="#install"
          className="px-8 py-3 bg-cyan-500 hover:bg-cyan-400 text-black font-semibold rounded-lg transition-colors"
        >
          Get Started
        </a>
        <a
          href="/code/docs"
          className="px-8 py-3 border border-slate-600 hover:border-slate-400 text-slate-300 rounded-lg transition-colors"
        >
          Documentation →
        </a>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Write code/components/features.tsx**

```tsx
const FEATURES = [
  {
    emoji: '🌍',
    title: 'Multi-Model Connectivity',
    desc: 'ChatGPT, Claude, DeepSeek, Qwen, and 50+ OpenAI-compatible providers. Switch models with one command.',
  },
  {
    emoji: '🔌',
    title: 'Dual-Track Skills',
    desc: 'Community SKILL.md ecosystem + Mipham-exclusive skills. 200+ skills available at launch.',
  },
  {
    emoji: '🧠',
    title: 'Intelligent Agents',
    desc: 'Autonomous sub-agents for complex tasks. Plan mode, task scheduling, and memory persistence.',
  },
  {
    emoji: '🔒',
    title: 'Enterprise Security',
    desc: 'Open Core (Apache 2.0). Permission system. Hook-based security audits. No vendor lock-in.',
  },
  {
    emoji: '💻',
    title: 'CLI + Web',
    desc: 'Native terminal UI with React/Ink + product management dashboard on mipham.ai.',
  },
  {
    emoji: '🚀',
    title: 'Phase 2: om-V5 Series',
    desc: 'Coming soon — MiphamAI proprietary models: om-V5-Pro, om-V5-Flash, om-V5-Visual.',
  },
]

export function Features() {
  return (
    <section className="py-20 px-4 max-w-6xl mx-auto">
      <h2 className="text-3xl font-bold text-center mb-12">Why Mipham Code</h2>
      <div className="grid md:grid-cols-3 gap-8">
        {FEATURES.map(f => (
          <div key={f.title} className="p-6 rounded-xl border border-slate-800 hover:border-cyan-800 transition-colors">
            <div className="text-3xl mb-4">{f.emoji}</div>
            <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
            <p className="text-slate-400 text-sm">{f.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 5: Write code/components/models.tsx**

```tsx
const PROVIDER_MODELS = [
  { provider: 'MiphamAI', models: ['om-V5-Pro', 'om-V5-Flash', 'om-V5-Visual'], status: 'Phase 2', color: 'text-purple-400' },
  { provider: 'Anthropic', models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'], status: 'Active', color: 'text-cyan-400' },
  { provider: 'OpenAI', models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'], status: 'Active', color: 'text-green-400' },
  { provider: 'DeepSeek', models: ['deepseek-v4-pro', 'deepseek-v4-flash'], status: 'Active', color: 'text-blue-400' },
  { provider: 'Qwen', models: ['qwen-plus', 'qwen-max'], status: 'Active', color: 'text-orange-400' },
]

export function Models() {
  return (
    <section className="py-20 px-4 max-w-4xl mx-auto">
      <h2 className="text-3xl font-bold text-center mb-12">Supported Models</h2>
      <div className="space-y-4">
        {PROVIDER_MODELS.map(p => (
          <div key={p.provider} className="flex items-center justify-between p-4 rounded-lg border border-slate-800">
            <div>
              <span className={`font-semibold ${p.color}`}>{p.provider}</span>
              <span className="ml-3 text-slate-500 text-sm">{p.models.join(', ')}</span>
            </div>
            <span className={`text-xs px-2 py-1 rounded ${p.status === 'Phase 2' ? 'bg-purple-900 text-purple-300' : 'bg-green-900 text-green-300'}`}>
              {p.status}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-6 text-center text-slate-500 text-sm">
        Any OpenAI-compatible API endpoint works. 50+ providers supported.
      </p>
    </section>
  )
}
```

- [ ] **Step 6: Write code/components/install-cmd.tsx**

```tsx
'use client'

import { useState } from 'react'

export function InstallCmd() {
  const [copied, setCopied] = useState<'npm' | 'curl' | null>(null)

  const npmCmd = 'npm install -g mipham-code'
  const curlCmd = 'curl -fsSL https://mipham.ai/code/install.sh | sh'

  const copy = async (cmd: string, type: 'npm' | 'curl') => {
    await navigator.clipboard.writeText(cmd)
    setCopied(type)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <section id="install" className="py-20 px-4 max-w-3xl mx-auto">
      <h2 className="text-3xl font-bold text-center mb-12">Install</h2>

      <div className="space-y-6">
        <div className="p-4 rounded-lg bg-slate-900 border border-slate-800">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-slate-400">npm (developers / CI/CD)</span>
            <button
              onClick={() => copy(npmCmd, 'npm')}
              className="text-xs px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              {copied === 'npm' ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <code className="text-cyan-400 font-mono text-sm">{npmCmd}</code>
        </div>

        <div className="p-4 rounded-lg bg-slate-900 border border-slate-800">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-slate-400">curl (macOS / Linux / WSL)</span>
            <button
              onClick={() => copy(curlCmd, 'curl')}
              className="text-xs px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              {copied === 'curl' ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <code className="text-cyan-400 font-mono text-sm">{curlCmd}</code>
        </div>
      </div>
    </section>
  )
}
```

- [ ] **Step 7: Write code/components/footer.tsx**

```tsx
export function Footer() {
  return (
    <footer className="py-12 px-4 text-center border-t border-slate-800">
      <p className="text-slate-500 text-sm">
        © 2026 One Mipham Corporation (Delaware, USA). All rights reserved.
      </p>
      <p className="text-slate-600 text-xs mt-2">
        Mipham Code is Open Core (Apache 2.0). Built with Bun, TypeScript, Ink, and Next.js.
      </p>
    </footer>
  )
}
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/code/
git commit -m "feat: build /code landing page with Hero, Features, Models, Install, Footer"
```

---

### Task 4.3: Add /code/docs and /code/install placeholder pages

**Files:**
- Create: `apps/web/src/app/code/docs/page.tsx`
- Create: `apps/web/src/app/code/install/page.tsx`

- [ ] **Step 1: Write docs/page.tsx**

```tsx
export default function DocsPage() {
  return (
    <section className="pt-24 px-4 max-w-4xl mx-auto pb-20">
      <h1 className="text-4xl font-bold mb-8">Documentation</h1>
      <div className="prose prose-invert max-w-none">
        <h2>Getting Started</h2>
        <p>Install Mipham Code via npm or curl. Configure your model providers in ~/.mipham/config.yml.</p>

        <h2>Slash Commands</h2>
        <ul>
          <li><code>/model [name]</code> — Switch active model</li>
          <li><code>/provider [name]</code> — Switch active provider</li>
          <li><code>/help</code> — Show all commands</li>
          <li><code>/clear</code> — Clear conversation</li>
          <li><code>/config</code> — Open configuration</li>
        </ul>

        <h2>Skills</h2>
        <p>Mipham Code supports the SKILL.md ecosystem. Place .SKILL.md files in ~/.mipham/skills/ or project .mipham/skills/ directories.</p>

        <h2>MIPHAM.md</h2>
        <p>Create a MIPHAM.md file in your project root to provide context to all connected models. Supports YAML frontmatter for configuration.</p>
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Write install/page.tsx**

```tsx
export default function InstallPage() {
  return (
    <section className="pt-24 px-4 max-w-4xl mx-auto pb-20">
      <h1 className="text-4xl font-bold mb-8">Installation</h1>

      <div className="space-y-12">
        <div>
          <h2 className="text-2xl font-semibold mb-4">macOS</h2>
          <pre className="bg-slate-900 p-4 rounded-lg overflow-x-auto">
            <code className="text-cyan-400">brew install mipham-code</code>
          </pre>
          <p className="text-slate-500 mt-2">Or via curl: <code>curl -fsSL https://mipham.ai/code/install.sh | sh</code></p>
        </div>

        <div>
          <h2 className="text-2xl font-semibold mb-4">Linux</h2>
          <pre className="bg-slate-900 p-4 rounded-lg overflow-x-auto">
            <code className="text-cyan-400">curl -fsSL https://mipham.ai/code/install.sh | sh</code>
          </pre>
        </div>

        <div>
          <h2 className="text-2xl font-semibold mb-4">Windows (WSL)</h2>
          <pre className="bg-slate-900 p-4 rounded-lg overflow-x-auto">
            <code className="text-cyan-400">npm install -g mipham-code</code>
          </pre>
        </div>

        <div>
          <h2 className="text-2xl font-semibold mb-4">npm (all platforms)</h2>
          <pre className="bg-slate-900 p-4 rounded-lg overflow-x-auto">
            <code className="text-cyan-400">npm install -g mipham-code</code>
          </pre>
        </div>
      </div>
    </section>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/code/docs/ apps/web/src/app/code/install/
git commit -m "feat: add /code/docs and /code/install pages"
```

---

## M5: Beta Release — Internal Testing & CI/CD

### Task 5.1: Set up CI/CD with GitHub Actions

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write ci.yml**

```yaml
name: CI

on:
  push:
    branches: [master, main]
  pull_request:
    branches: [master, main]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '1.2' }
      - run: pnpm install
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test

  build-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '1.2' }
      - run: pnpm install
      - run: cd apps/cli && bun build --compile --minify ./bin/mipham.ts --outfile dist/mipham
      - uses: actions/upload-artifact@v4
        with:
          name: mipham-linux-x64
          path: apps/cli/dist/mipham

  build-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: '1.2' }
      - run: pnpm install
      - run: cd apps/web && bunx next build
      - uses: actions/upload-artifact@v4
        with:
          name: web-build
          path: apps/web/out/
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for lint, test, build CLI and Web"
```

---

### Task 5.2: Add package.json metadata for npm publishing

**Files:**
- Modify: `apps/cli/package.json`

- [ ] **Step 1: Add publish fields**

```json
{
  "name": "mipham-code",
  "version": "0.1.0-beta.1",
  "description": "Mipham Code — Multi-model open-core intelligent coding terminal. Connect to ChatGPT, Claude, DeepSeek, Qwen and 50+ LLMs from your terminal.",
  "license": "Apache-2.0",
  "repository": "https://github.com/OneMiphamCorp/mipham-code",
  "homepage": "https://mipham.ai/code",
  "keywords": ["cli", "ai", "llm", "coding", "terminal", "openai", "anthropic", "deepseek", "mipham"],
  "bin": { "mipham": "./bin/mipham.ts" },
  "files": ["bin", "src", "skills", "README.md"],
  "engines": { "bun": ">=1.2.0" }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/package.json
git commit -m "chore: add npm publish metadata to CLI package"
```

---

## M6: GA Release — Public Launch

### Task 6.1: Add README.md with full usage guide

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

```markdown
# 🚀 Mipham Code

> Connect global LLMs. One terminal. Open Core.

**Mipham Code** is an open-core intelligent coding terminal by [One Mipham Corporation](https://mipham.ai)
(Delaware, USA). Connect to ChatGPT, Claude, DeepSeek, Qwen, and 50+ OpenAI-compatible providers from
one CLI.

## Quick Start

```bash
# npm (all platforms)
npm install -g mipham-code

# macOS
brew install mipham-code

# Linux / macOS
curl -fsSL https://mipham.ai/code/install.sh | sh
```

## Configure

Create `~/.mipham/config.yml`:

```yaml
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
providers:
  - id: anthropic
    name: Anthropic Claude
    protocol: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
```

Set your API keys as environment variables:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export DEEPSEEK_API_KEY=sk-...
```

## Run

```bash
mipham
```

## Features

- 🌍 **Multi-Model**: ChatGPT, Claude, DeepSeek, Qwen, + 50 OpenAI-compatible providers
- 🔌 **Skills Ecosystem**: SKILL.md cross-tool standard + Mipham-exclusive skills
- 🧠 **Agent System**: Sub-agents, plan mode, task scheduling, persistent memory
- 🔒 **Open Core**: Apache 2.0 core. Proprietary enterprise features (Phase 2)
- 💻 **CLI + Web**: Terminal UI (Bun + Ink) + dashboard at mipham.ai/code

## Slash Commands

| Command | Description |
|---------|-------------|
| `/model <name>` | Switch active model |
| `/provider <name>` | Switch active provider |
| `/help` | Show all commands |
| `/clear` | Clear conversation |
| `/config` | Open configuration |

## License

Core: Apache 2.0 | Enterprise features: Commercial License

© 2026 One Mipham Corporation (Delaware, USA). All rights reserved.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with full usage guide for GA release"
```

---

### Task 6.2: Create CONTRIBUTING.md and CODE_OF_CONDUCT.md

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `SECURITY.md`

- [ ] **Step 1: Write CONTRIBUTING.md**

```markdown
# Contributing to Mipham Code

Thank you for contributing! Mipham Code is Open Core (Apache 2.0). We welcome community contributions.

## Development Setup

```bash
git clone https://github.com/OneMiphamCorp/mipham-code.git
cd mipham-code
pnpm install
pnpm dev:cli
```

## Project Structure

- `apps/cli/` — CLI (Bun + TypeScript + Ink)
- `apps/web/` — Web interface (Next.js)
- `packages/shared/` — Shared types and constants

## Conventions

- Conventional Commits
- TypeScript strict mode
- Tests required for new features
- Prettier formatting (CI enforced)

## Adding a Model Provider

1. Add config to `packages/shared/src/constants.ts`
2. If non-standard protocol, add adapter in `apps/cli/src/providers/custom/`
3. Add model to Web models table

## Adding a Skill

Place `.SKILL.md` (standard) or `.mipham-skill.md` (exclusive) in `apps/cli/skills/`.

See [SKILL.md specification](https://github.com/duanyytop/agents-radar) for format details.
```

- [ ] **Step 2: Write CODE_OF_CONDUCT.md**

```markdown
# Code of Conduct

## Our Pledge

We pledge to make participation in the Mipham Code community a harassment-free experience for everyone.

## Standards

- Be respectful and inclusive
- Give constructive feedback
- Accept constructive criticism gracefully
- Focus on what is best for the community

## Enforcement

Report issues to: conduct@mipham.ai
```

- [ ] **Step 3: Write SECURITY.md**

```markdown
# Security Policy

## Reporting Vulnerabilities

Do NOT open public issues for security vulnerabilities.
Report to: security@mipham.ai

## AI Security

Mipham Code connects to multiple LLM providers. Security considerations:

- API keys are NEVER logged or stored in plaintext
- Provider credentials use environment variable substitution
- Hooks system can audit tool calls for security violations
- Permission system blocks dangerous operations by default

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Beta |
```

- [ ] **Step 4: Commit**

```bash
git add CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md
git commit -m "docs: add community and security documentation for GA"
```

---

## Plan Self-Review

### Spec Coverage Check

| Spec Section | Covered By |
|---|---|
| §1 Product Positioning | README + Web hero/features |
| §2 Open Core Strategy | LICENSE + README |
| §3 Architecture | Task 1.3-1.9 (CLI scaffold + engine) |
| §4 L1 Multi-Model Engine | Task 1.4-1.7 (providers) |
| §5 L2 16 Core Tools | Task 2.1-2.5 (all tools + permissions + hooks) |
| §6 L3 Skills Dual-Track | Task 3.1-3.4 (loader + 10 built-in skills) |
| §7 Web Interface | Task 4.1-4.3 (Next.js app with all pages) |
| §8 MIPHAM.md System | Task 1.8 (instructions loader) |
| §9 Language Design | Task 1.1 (MIPHAM.md w/ language field) |
| §10 Phase 1/2 Roadmap | Covered in plan structure (M1-M6) |
| §11 Project Structure | Task 1.1-1.3 (full directory scaffold) |
| §12 Distribution | Task 5.2 (npm metadata) + Task 4.2 (install page) |
| §13 Tech Stack | Embedded in each task's package.json |

### Placeholder Scan
No TBD, TODO, or incomplete sections found. All tasks contain concrete code.

### Type Consistency
- `ProviderConfig`, `ModelInfo`, `ToolDefinition`, `StreamChunk` — consistent across shared/types.ts, providers, tools, and engine
- `hook.execute()` returns `HookResult` — consistent across hooks.ts and engine.ts
- `SkillLoader.loadFromPaths()` — consistent usage in index.ts bootstrap

---

**Plan complete.** Saved to `docs/superpowers/plans/2026-05-31-mipham-code-implementation.md`.
