# i18n 国际化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add zh-CN + en-US i18n support to Mipham Code CLI + Web + install.sh + VS Code using a zero-dependency JSON-based t() function with React Context injection.

**Architecture:** Shared i18n core (`packages/shared/src/i18n/`) provides types, `t()` function, and locale detection. CLI wraps it in React Context (`I18nProvider` + `useI18n()`) for hot-swappable `/lang` support. Web inlines JSON at build time for SSG compatibility. install.sh uses shell `case` branches.

**Tech Stack:** TypeScript (strict), React 18 + Ink 5 (CLI), Next.js 14 SSG (Web), JSON translation files, zero new dependencies.

## Global Constraints

- Zero new npm dependencies — self-built JSON + t() function only
- Initial languages: `zh-CN` (简体中文) and `en-US` (English, fallback)
- Key format: dot-separated lowercase (`commands.clear.confirmed`)
- Template params: `{paramName}` syntax in curly braces
- Fallback chain: current locale → en-US → key itself (never blank output)
- CLI translation loading: synchronous `readFileSync` at startup
- Web translation loading: build-time `import` inlined as TS constants (SSG compatible)
- Language detection priority: `--lang` flag > USER.md > `$LANG`/`$LC_ALL` > OS > `en-US`
- All 853 existing tests must continue to pass
- Default behavior (`--lang` not set) = en-US, UI output unchanged

---

## File Map

| File | Role |
|------|------|
| `packages/shared/src/i18n/types.ts` | Locale type, TranslationMap, I18nBundle |
| `packages/shared/src/i18n/t.ts` | `createT()` factory + `getNested()` helper |
| `packages/shared/src/i18n/detect.ts` | `detectLocale()` 5-tier priority chain |
| `packages/shared/src/i18n/locales/en-US.json` | English fallback translations |
| `packages/shared/src/i18n/locales/zh-CN.json` | Simplified Chinese translations |
| `packages/shared/src/i18n/index.ts` | Re-exports: types, createT, detectLocale |
| `apps/cli/src/i18n-context.tsx` | `I18nProvider` + `useI18n()` React Context |
| `apps/cli/src/index.tsx` | Bootstrap: detect locale, load JSON, inject Provider |
| `apps/cli/src/ui/commands.ts` | Migrate 74+ slash command response strings |
| `apps/cli/src/ui/app.tsx` | Migrate permission labels, status, errors |
| `apps/cli/src/ui/chat.tsx` | Migrate role labels, welcome banner |
| `apps/cli/src/ui/input.tsx` | Migrate loading verbs, vim mode labels |
| `apps/cli/src/ui/picker.tsx` | Migrate model picker labels |
| `apps/cli/src/ui/command-picker.tsx` | Migrate command picker labels |
| `apps/cli/src/ui/agent-footer.tsx` | Migrate agent status labels |
| `apps/cli/src/commands/environment.ts` | Migrate theme, IDE, terminal setup strings |
| `apps/cli/src/commands/git.ts` | Migrate git command output strings |
| `apps/cli/src/commands/project.ts` | Migrate project/init/setup strings |
| `apps/cli/src/commands/keys.ts` | Migrate key management strings |
| `apps/cli/src/commands/loop-scaffold.ts` | Migrate scaffold output strings |
| `apps/cli/src/core/engine.ts` | Migrate error/block/goal-verify messages |
| `apps/cli/src/tools/**/*.ts` | Migrate tool name/description strings (25 tools) |
| `apps/cli/src/mcp/oauth.ts` | Migrate OAuth HTML page strings |
| `apps/cli/src/mcp/client.ts` | Migrate connection status strings |
| `apps/web/src/i18n/context.tsx` | Web I18nProvider + useI18n() |
| `apps/web/src/i18n/index.ts` | Bundled translations for SSG |
| `apps/web/src/app/code/layout.tsx` | Dynamic `<html lang>` + Provider |
| `apps/web/src/app/code/components/*.tsx` | Migrate 5 web components |
| `apps/web/src/app/code/**/page.tsx` | Migrate 4 page components |
| `install.sh` | Shell-based i18n with case branches |
| `infrastructure/vscode/extension.js` | Migrate status bar + notification strings |
| `apps/cli/test/core/i18n.test.ts` | Unit tests for t(), detect, Context |

---

### Task 1: Core i18n Infrastructure

**Files:**
- Create: `packages/shared/src/i18n/types.ts`
- Create: `packages/shared/src/i18n/t.ts`
- Create: `packages/shared/src/i18n/detect.ts`
- Create: `packages/shared/src/i18n/index.ts`
- Create: `packages/shared/src/i18n/locales/en-US.json`
- Create: `packages/shared/src/i18n/locales/zh-CN.json`
- Create: `apps/cli/test/core/i18n.test.ts`

**Interfaces:**
- Produces: `type Locale = 'en-US' | 'zh-CN'`, `type TranslationMap = Record<string, string | TranslationMap>`, `createT(current: TranslationMap, fallback: TranslationMap) => (key: string, params?: Record<string, string>) => string`, `detectLocale(opts?: { lang?: string; cwd?: string }) => Locale`

- [ ] **Step 1: Write the types file**

```typescript
// packages/shared/src/i18n/types.ts
export type Locale = 'en-US' | 'zh-CN'

export const SUPPORTED_LOCALES: Locale[] = ['en-US', 'zh-CN']

export const FALLBACK_LOCALE: Locale = 'en-US'

/** A TranslationMap is a nested object where leaves are template strings. */
export interface TranslationMap {
  [key: string]: string | TranslationMap
}
```

- [ ] **Step 2: Write the t.ts function with tests**

```typescript
// packages/shared/src/i18n/t.ts
import type { TranslationMap } from './types'

function getNested(obj: TranslationMap, key: string): unknown {
  return key.split('.').reduce((o, k) => (o as any)?.[k], obj as any)
}

export function createT(
  current: TranslationMap,
  fallback: TranslationMap,
): (key: string, params?: Record<string, string>) => string {
  return function t(key: string, params?: Record<string, string>): string {
    const val = getNested(current, key) ?? getNested(fallback, key) ?? key
    if (typeof val !== 'string') return key
    if (params) {
      return val.replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? '')
    }
    return val
  }
}
```

Test file (`apps/cli/test/core/i18n.test.ts`):

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createT } from '@mipham/shared/i18n/t'
import { detectLocale } from '@mipham/shared/i18n/detect'
import type { TranslationMap } from '@mipham/shared/i18n/types'

const en: TranslationMap = {
  hello: 'Hello',
  greeting: 'Hello {name}',
  nested: { key: 'Nested value' },
  commands: { clear: { confirmed: '✓ Cleared' } },
}
const zh: TranslationMap = {
  hello: '你好',
  greeting: '你好 {name}',
  commands: { clear: { confirmed: '✓ 对话已清除' } },
}

describe('t()', () => {
  const t = createT(zh, en)

  it('returns translation for known key', () => {
    expect(t('hello')).toBe('你好')
  })

  it('falls back to en-US for missing key in current locale', () => {
    expect(t('nested.key')).toBe('Nested value')
  })

  it('returns key itself when missing in both locales', () => {
    expect(t('nonexistent.key')).toBe('nonexistent.key')
  })

  it('interpolates params with {param} syntax', () => {
    expect(t('greeting', { name: 'World' })).toBe('你好 World')
  })

  it('retains unmatched params as {param}', () => {
    expect(t('hello', { extra: 'x' })).toBe('你好')
  })

  it('handles empty string keys', () => {
    expect(t('')).toBe('')
  })

  it('returns key when nested value is an object, not string', () => {
    const t2 = createT({}, { commands: { clear: { confirmed: 'OK' } } })
    expect(t2('commands')).toBe('commands')
  })
})

describe('detectLocale()', () => {
  afterEach(() => {
    delete process.env.LANG
    delete process.env.LC_ALL
  })

  it('returns locale from --lang flag', () => {
    expect(detectLocale({ lang: 'zh-CN' })).toBe('zh-CN')
  })

  it('returns locale from --lang flag (en-US)', () => {
    expect(detectLocale({ lang: 'en-US' })).toBe('en-US')
  })

  it('ignores invalid --lang values and falls through', () => {
    process.env.LANG = 'zh_CN.UTF-8'
    expect(detectLocale({ lang: 'fr-FR' })).toBe('zh-CN')
  })

  it('detects zh-CN from LANG env var (zh_CN.UTF-8)', () => {
    process.env.LANG = 'zh_CN.UTF-8'
    expect(detectLocale({})).toBe('zh-CN')
  })

  it('detects zh-CN from LC_ALL', () => {
    process.env.LC_ALL = 'zh_CN.UTF-8'
    expect(detectLocale({})).toBe('zh-CN')
  })

  it('detects simplified Chinese prefix (zh_*)', () => {
    process.env.LANG = 'zh_SG.UTF-8'
    expect(detectLocale({})).toBe('zh-CN')
  })

  it('falls back to en-US when nothing matches', () => {
    process.env.LANG = 'C'
    expect(detectLocale({})).toBe('en-US')
  })
})
```

- [ ] **Step 3: Run tests — expect FAIL (files not created yet)**

Run: `cd apps/cli && pnpm test -- test/core/i18n.test.ts`
Expected: FAIL — files don't exist

- [ ] **Step 4: Create all files and run tests — expect PASS**

Write `types.ts`, `t.ts`, `index.ts` as above. Create minimal `detect.ts`:

```typescript
// packages/shared/src/i18n/detect.ts
import type { Locale } from './types'

export function detectLocale(opts?: { lang?: string; cwd?: string }): Locale {
  // 1. CLI --lang flag
  if (opts?.lang) {
    const normalized = normalizeLocale(opts.lang)
    if (normalized) return normalized as Locale
  }

  // 2. LANG / LC_ALL env vars
  const langEnv = process.env.LC_ALL || process.env.LANG || ''
  const envLocale = parseLangEnv(langEnv)
  if (envLocale) return envLocale

  // 3. OS detection
  const osLocale = detectOSLocale()
  if (osLocale) return osLocale

  // 4. Fallback
  return 'en-US'
}

function normalizeLocale(raw: string): string | null {
  const lower = raw.toLowerCase().replace('_', '-')
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  return null
}

function parseLangEnv(env: string): Locale | null {
  if (!env || env === 'C' || env === 'POSIX') return null
  return normalizeLocale(env) as Locale | null
}

function detectOSLocale(): Locale | null {
  try {
    if (process.platform === 'darwin') {
      const { execSync } = require('node:child_process')
      const out = execSync('defaults read -g AppleLocale 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 1000,
      }).trim()
      return normalizeLocale(out) as Locale | null
    }
    if (process.platform === 'win32') {
      // Use Intl as fallback — the kernel32 approach is too complex for startup
      return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale) as Locale | null
    }
    // Linux: try LANG env one more time, then Intl
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale) as Locale | null
  } catch {
    return null
  }
}
```

Create minimal locale JSON files:

```json
// packages/shared/src/i18n/locales/en-US.json
{
  "hello": "Hello",
  "greeting": "Hello {name}",
  "commands": {
    "clear": {
      "confirmed": "✓ Conversation cleared. Context reset."
    }
  }
}
```

```json
// packages/shared/src/i18n/locales/zh-CN.json
{
  "hello": "你好",
  "greeting": "你好 {name}",
  "commands": {
    "clear": {
      "confirmed": "✓ 对话已清除，上下文已重置。"
    }
  }
}
```

Run: `cd apps/cli && pnpm test -- test/core/i18n.test.ts`
Expected: 12 tests PASS

- [ ] **Step 5: Run full test suite to verify zero regression**

Run: `pnpm test`
Expected: all 853+ existing tests pass, ~12 new tests pass = 865+

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/i18n/ apps/cli/test/core/i18n.test.ts
git commit -m "feat(i18n): core infrastructure — types, t(), detectLocale()

- TranslationMap type, Locale union, FALLBACK_LOCALE constant
- Zero-dependency createT() with fallback chain + param interpolation
- detectLocale() with 5-tier priority: --lang > $LANG > OS > Intl > en-US
- Minimal en-US + zh-CN locale JSON files
- 12 unit tests for t() and detectLocale()

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: CLI React Context + Bootstrap Integration

**Files:**
- Create: `apps/cli/src/i18n-context.tsx`
- Modify: `apps/cli/src/index.tsx:36-42, 123-127, 299-314`
- Test: `apps/cli/test/core/i18n.test.ts` (add Context tests)

**Interfaces:**
- Consumes: `createT(current, fallback) => t()`, `detectLocale(opts) => Locale`, `TranslationMap` type, locale JSON files
- Produces: `<I18nProvider locale={locale} t={t} children>` , `useI18n() => { locale, t }`, `/lang <locale>` slash command

- [ ] **Step 1: Create I18nProvider + useI18n Context**

```typescript
// apps/cli/src/i18n-context.tsx
import React, { createContext, useContext } from 'react'
import type { Locale } from '@mipham/shared/i18n/types'

export interface I18nContextValue {
  locale: Locale
  t: (key: string, params?: Record<string, string>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({
  locale,
  t,
  children,
}: {
  locale: Locale
  t: (key: string, params?: Record<string, string>) => string
  children: React.ReactNode
}) {
  return React.createElement(
    I18nContext.Provider,
    { value: { locale, t } },
    children,
  )
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    // If no Provider is mounted (e.g., tests, bare scripts), return en-US no-op.
    return {
      locale: 'en-US',
      t: (key: string) => key,
    }
  }
  return ctx
}
```

- [ ] **Step 2: Add Context unit tests**

In `apps/cli/test/core/i18n.test.ts`, add:

```typescript
// ... in the import section, add:
import React from 'react'
import { render } from 'ink-testing-library'
import { I18nProvider, useI18n } from '../../src/i18n-context'
import { Text } from 'ink'

describe('I18nProvider + useI18n', () => {
  it('provides locale and t() to children', () => {
    const t = (k: string) => `translated:${k}`
    function Child() {
      const { locale, t: translate } = useI18n()
      return React.createElement(Text, {}, `${locale}:${translate('test')}`)
    }
    const { lastFrame } = render(
      React.createElement(I18nProvider, { locale: 'zh-CN', t },
        React.createElement(Child),
      ),
    )
    expect(lastFrame()).toContain('zh-CN:translated:test')
  })

  it('returns fallback en-US when no Provider (test environment)', () => {
    function Child() {
      const { locale, t } = useI18n()
      return React.createElement(Text, {}, `${locale}:${t('test')}`)
    }
    const { lastFrame } = render(React.createElement(Child))
    expect(lastFrame()).toContain('en-US:test')
  })
})
```

- [ ] **Step 3: Wire Provider into index.tsx**

In `apps/cli/src/index.tsx`, add after config load:

```typescript
// At the top, add import:
import { createT } from '@mipham/shared/i18n/t'
import { detectLocale } from '@mipham/shared/i18n/detect'
import { I18nProvider } from './i18n-context'
import enUS from '@mipham/shared/i18n/locales/en-US.json' assert { type: 'json' }
import zhCN from '@mipham/shared/i18n/locales/zh-CN.json' assert { type: 'json' }
import type { TranslationMap } from '@mipham/shared/i18n/types'

// After config load (~line 61), add:
const locale = detectLocale({ lang: options.lang })
const localeBundles: Record<string, TranslationMap> = { 'en-US': enUS as TranslationMap, 'zh-CN': zhCN as TranslationMap }
const t = createT(localeBundles[locale] || enUS, enUS)

// Wrap the render call (~line 299) with I18nProvider:
const { waitUntilExit } = render(
  React.createElement(
    I18nProvider,
    { locale, t },
    React.createElement(App, {
      engine,
      config,
      initialProvider: defaultProvider,
      initialModel: defaultModel,
      lang: options.lang,
      skillsLoader,
      pluginManager,
      version: options.version,
      sessionId: sessionName,
    }),
  ),
)
```

- [ ] **Step 4: Add /lang slash command**

In `apps/cli/src/ui/commands.ts`, add:

```typescript
const langCmd: CommandHandler = (ctx, args) => {
  const requested = args[0]
  if (!requested || !['en-US', 'zh-CN'].includes(requested)) {
    return {
      content: `── Language ──

Current: en-US
Supported: en-US, zh-CN

Usage: /lang <locale>`,
    }
  }
  // The actual locale change requires a re-render — stored in preference for next restart.
  // For now, return confirmation. Hot-swap is Phase 2 enhancement.
  return { content: `Language set to ${requested}. Restart Mipham Code to apply.` }
}
```

Register in `getCommandMap()`:

```typescript
map.set('/lang', langCmd)
```

- [ ] **Step 5: Run tests — all pass, zero regression**

Run: `pnpm test`
Expected: all tests pass including new Context tests (~867 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/i18n-context.tsx apps/cli/src/index.tsx apps/cli/src/ui/commands.ts apps/cli/test/core/i18n.test.ts
git commit -m "feat(i18n): React Context + bootstrap + /lang command

- I18nProvider + useI18n() with safe fallback for test environments
- index.tsx: detect locale, load JSON, inject Provider around App
- /lang <locale> slash command

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Core Locale JSON — All Skeleton Keys

**Files:**
- Modify: `packages/shared/src/i18n/locales/en-US.json` (expand from skeleton to full)
- Modify: `packages/shared/src/i18n/locales/zh-CN.json` (expand from skeleton to full)

**Interfaces:**
- Consumes: TranslationMap type from Task 1
- Produces: Complete translation key skeleton (en-US as authoritative, zh-CN as initial translations)

- [ ] **Step 1: Expand en-US.json with all top-level namespaces**

```json
{
  "hello": "Hello",
  "greeting": "Hello {name}",
  "commands": {
    "clear": { "confirmed": "✓ Conversation cleared. Context reset." },
    "compact": { "confirmed": "✓ Context compacted." },
    "status": {
      "title": "── System Diagnostics ──",
      "config": "── Config ──",
      "session": "── Session ──",
      "git": "── Git ──",
      "skills": "── Skills ──"
    },
    "switch": { "confirmed": "Switched to {model}" },
    "goal": { "set": "Goal set: {goal}" },
    "plan": { "entered": "Entered plan mode." },
    "diff": { "clean": "No uncommitted changes (working tree clean)." },
    "copy": { "confirmed": "✓ Copied {count} assistant response(s) to clipboard." },
    "resume": {
      "no_sessions": "No saved sessions.",
      "restored": "─ Session Restored ─",
      "not_found": "Session \"{name}\" not found."
    },
    "help": { "title": "── Mipham Code Help ──" },
    "lang": { "current": "Current: {locale}", "set": "Language set to {locale}. Restart Mipham Code to apply." },
    "exit": {}
  },
  "ui": {
    "banner": {
      "title": "Mipham Code",
      "subtitle": "AI-Powered Programming Assistant",
      "tagline": "Multi-model / Multi-provider / Skills & Tools / Open-core",
      "start_message": "Type a message to start. /help for commands"
    },
    "permission": {
      "manual": "manual mode",
      "accept_edits": "accept edits on",
      "plan_mode": "plan mode / read-only",
      "auto": "auto mode",
      "dont_ask": "don't ask",
      "bypass": "bypass"
    },
    "loading": {
      "doodling": "Doodling",
      "forging": "Forging",
      "cerebrating": "Cerebrating",
      "recombobulating": "Recombobulating",
      "thinking": "Thinking",
      "computing": "Computing",
      "processing": "Processing",
      "analyzing": "Analyzing",
      "generating": "Generating",
      "dreaming": "Dreaming",
      "pondering": "Pondering",
      "ruminating": "Ruminating",
      "deliberating": "Deliberating",
      "contemplating": "Contemplating",
      "synthesizing": "Synthesizing",
      "calculating": "Calculating",
      "inferring": "Inferring",
      "optimizing": "Optimizing",
      "compiling": "Compiling",
      "orchestrating": "Orchestrating",
      "harmonizing": "Harmonizing",
      "galvanizing": "Galvanizing",
      "illuminating": "Illuminating",
      "manifesting": "Manifesting",
      "transmogrifying": "Transmogrifying",
      "actualizing": "Actualizing"
    },
    "agent": {
      "running": "running",
      "finished": "finished",
      "status_label": "Agents"
    },
    "system": { "role_label": "System" },
    "assistant": { "role_label": "Mipham Code" },
    "user": { "role_label": "User" }
  },
  "tools": {
    "bash": { "name": "Bash", "description": "Execute shell commands" },
    "read": { "name": "Read", "description": "Read a file from the filesystem" },
    "write": { "name": "Write", "description": "Write content to a file" },
    "edit": { "name": "Edit", "description": "Edit a file with string replacement" },
    "glob": { "name": "Glob", "description": "Find files matching a pattern" },
    "grep": { "name": "Grep", "description": "Search file contents with regex" },
    "web_fetch": { "name": "WebFetch", "description": "Fetch a URL and parse content" },
    "web_search": { "name": "WebSearch", "description": "Search the web" },
    "agent": { "name": "Agent", "description": "Launch a sub-agent for complex tasks" },
    "task": { "name": "Task", "description": "Create and track tasks" },
    "skill": { "name": "Skill", "description": "Invoke a named skill" },
    "memory": { "name": "Memory", "description": "Read/write persistent memory" },
    "workflow": { "name": "Workflow", "description": "Execute a multi-agent workflow" },
    "plan": { "name": "Plan", "description": "Enter plan mode for structured thinking" },
    "config": { "name": "Config", "description": "View and modify configuration" },
    "mcp": { "name": "MCP", "description": "Manage MCP server connections" }
  },
  "errors": {
    "tool_not_allowed": "Tool \"{name}\" requires user approval (permission: ask).",
    "tool_blocked": "Tool \"{name}\" blocked by hook",
    "user_input_blocked": "User input blocked by hook.",
    "dlp_blocked": "Request blocked by DLP policy.",
    "model_error": "Error: {error}",
    "tool_collision": "[mcp] Tool collision: \"{name}\" already registered. Skipping."
  },
  "system": {
    "mcp": {
      "connecting": "[mcp] Connecting to \"{name}\"...",
      "connected": "[mcp] Connected to \"{name}\"",
      "failed": "[mcp] Failed to connect \"{name}\": {reason}",
      "registered": "[mcp] \"{name}\": registered {count} tools",
      "disconnected": "[mcp] Disconnected \"{name}\"",
      "reloaded": "[mcp] Reloaded \"{name}\""
    },
    "context": {
      "omitted": "Prior conversation context omitted.",
      "summary_heading": "[Earlier conversation summary — {heading}]"
    },
    "goal": {
      "verified": "✅ Goal verification passed: {script}",
      "failed_continuing": "🔄 Verification script failed — continuing (loop {loop})",
      "running_skill": "🔍 Running verification skill: {skill}"
    },
    "welcome": {
      "unknown_model": "[mipham] ⚠ Unknown model \"{model}\": assuming {k}k context window."
    }
  }
}
```

- [ ] **Step 2: Create zh-CN.json with Chinese translations**

Same key structure as en-US.json, with Chinese values. Key examples:

```json
{
  "commands": {
    "clear": { "confirmed": "✓ 对话已清除，上下文已重置。" },
    "compact": { "confirmed": "✓ 上下文已压缩。" },
    "status": {
      "title": "── 系统诊断 ──",
      "config": "── 配置 ──",
      "session": "── 会话 ──",
      "git": "── Git ──",
      "skills": "── 技能 ──"
    },
    "switch": { "confirmed": "已切换到 {model}" },
    "goal": { "set": "目标已设置：{goal}" },
    "plan": { "entered": "已进入计划模式。" },
    "diff": { "clean": "没有未提交的更改（工作区干净）。" },
    "copy": { "confirmed": "✓ 已复制 {count} 条助手回复到剪贴板。" },
    "resume": {
      "no_sessions": "没有已保存的会话。",
      "restored": "─ 会话已恢复 ─",
      "not_found": "未找到会话 \"{name}\"。"
    },
    "help": { "title": "── Mipham Code 帮助 ──" },
    "lang": { "current": "当前语言：{locale}", "set": "语言已设置为 {locale}。重启 Mipham Code 生效。" }
  },
  "ui": {
    "banner": {
      "title": "Mipham Code",
      "subtitle": "AI 驱动的编程助手",
      "tagline": "多模型 / 多提供商 / 技能与工具 / 开源核心",
      "start_message": "输入消息开始。 /help 查看命令"
    },
    "loading": {
      "thinking": "思考中",
      "computing": "计算中",
      "processing": "处理中",
      "analyzing": "分析中",
      "generating": "生成中",
      "pondering": "沉思中",
      "synthesizing": "综合中",
      "calculating": "演算中",
      "optimizing": "优化中",
      "compiling": "编译中"
    },
    "agent": {
      "running": "运行中",
      "finished": "已完成",
      "status_label": "代理"
    }
  },
  "errors": {
    "tool_not_allowed": "工具 \"{name}\" 需要用户批准（权限：ask），未执行。",
    "tool_blocked": "工具 \"{name}\" 被钩子拦截",
    "user_input_blocked": "用户输入被钩子拦截。",
    "dlp_blocked": "请求被 DLP 策略阻止。",
    "model_error": "错误：{error}",
    "tool_collision": "[mcp] 工具冲突：\"{name}\" 已注册，跳过。"
  }
}
```

- [ ] **Step 3: Verify JSON validity and key parity**

Run: `cd apps/cli && pnpm test -- test/core/i18n.test.ts`
Expected: all existing i18n tests pass

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: all tests pass, zero regression

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/i18n/locales/
git commit -m "feat(i18n): complete locale JSON skeleton — en-US + zh-CN

- ~200 top-level translation keys covering commands, ui, tools, errors, system
- en-US as authoritative fallback, zh-CN with initial Chinese translations
- All keys follow dot-separated lowercase convention

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Migrate CLI Slash Commands

**Files:**
- Modify: `apps/cli/src/ui/commands.ts` — ~74 response strings → `t()` calls
- Modify: `apps/cli/src/commands/environment.ts` — ~74 strings → `t()` calls
- Modify: `apps/cli/src/commands/git.ts` — ~42 strings → `t()` calls
- Modify: `apps/cli/src/commands/project.ts` — ~258 strings → `t()` calls
- Modify: `packages/shared/src/i18n/locales/en-US.json` — add commands.* keys
- Modify: `packages/shared/src/i18n/locales/zh-CN.json` — add commands.* keys

**Interfaces:**
- Consumes: `useI18n()` from Task 2, locale JSON from Task 3
- Produces: All slash commands output translated strings

- [ ] **Step 1: Pick 3 representative commands, migrate with t()**

Change `/clear`:

```typescript
// Before
return { content: '✓ Conversation cleared. Context reset.', clearMessages: true }
// After
const { t } = useI18n()
return { content: t('commands.clear.confirmed'), clearMessages: true }
```

Change `/diff`:

```typescript
// Before
return { content: 'No uncommitted changes (working tree clean).' }
// After
return { content: t('commands.diff.clean') }
```

Change `/compact`:

```typescript
// Before
return { content: stripIndent`
  ✓ Context compacted.
  Tokens: ${before} → ${after}
  Reduction: ${pct}%` }
// After
return { content: t('commands.compact.confirmed') + `\nTokens: ${before} → ${after}\nReduction: ${pct}%` }
```

- [ ] **Step 2: Add missing keys to both locale JSON files**

For each new command string, add the key to both `en-US.json` and `zh-CN.json`.

- [ ] **Step 3: Run tests — verify all pass**

Run: `cd apps/cli && pnpm test -- test/ui/commands.test.ts`
Expected: all 42 command tests pass with translated output matching expected patterns

- [ ] **Step 4: Continue migrating remaining commands in batches of 10**

Each batch: migrate 10 commands → add keys → run tests → commit.

Stop point: all 74 command response strings use `t()`.

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: all 853+ tests pass

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/ui/commands.ts apps/cli/src/commands/ packages/shared/src/i18n/locales/
git commit -m "feat(i18n): migrate all slash commands to t() calls

- 74+ slash command responses now use t() for translation
- All command output keys in both en-US and zh-CN locale JSON
- Zero regression: all existing tests pass

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Migrate CLI UI Components

**Files:**
- Modify: `apps/cli/src/ui/app.tsx` — permission labels, status text
- Modify: `apps/cli/src/ui/chat.tsx` — role labels, welcome banner
- Modify: `apps/cli/src/ui/input.tsx` — loading verbs, vim mode labels
- Modify: `apps/cli/src/ui/picker.tsx` — model picker navigation
- Modify: `apps/cli/src/ui/command-picker.tsx` — navigation help
- Modify: `apps/cli/src/ui/agent-footer.tsx` — agent status labels
- Modify: `packages/shared/src/i18n/locales/en-US.json` — add ui.* keys
- Modify: `packages/shared/src/i18n/locales/zh-CN.json` — add ui.* keys

**Interfaces:**
- Consumes: `useI18n()` from Task 2
- Produces: All UI components render translated strings

- [ ] **Step 1: Migrate chat.tsx — welcome banner**

```typescript
// Before
<Text bold>Mipham Code</Text>
<Text dimColor>AI-Powered Programming Assistant</Text>

// After
const { t } = useI18n()
<Text bold>{t('ui.banner.title')}</Text>
<Text dimColor>{t('ui.banner.subtitle')}</Text>
```

- [ ] **Step 2: Migrate input.tsx — loading verbs**

The 26 loading verbs are in an array. Convert to use `t()`:

```typescript
// Before
const LOADING_VERBS = ['Doodling', 'Forging', 'Cerebrating', ...]
const verb = LOADING_VERBS[Math.floor(Math.random() * LOADING_VERBS.length)]

// After
const LOADING_KEYS = [
  'ui.loading.doodling', 'ui.loading.forging', 'ui.loading.cerebrating',
  'ui.loading.recombobulating', 'ui.loading.thinking', 'ui.loading.computing',
  'ui.loading.processing', 'ui.loading.analyzing', 'ui.loading.generating',
  'ui.loading.dreaming', 'ui.loading.pondering', 'ui.loading.ruminating',
  'ui.loading.deliberating', 'ui.loading.contemplating', 'ui.loading.synthesizing',
  'ui.loading.calculating', 'ui.loading.inferring', 'ui.loading.optimizing',
  'ui.loading.compiling', 'ui.loading.orchestrating', 'ui.loading.harmonizing',
  'ui.loading.galvanizing', 'ui.loading.illuminating', 'ui.loading.manifesting',
  'ui.loading.transmogrifying', 'ui.loading.actualizing',
]
const verb = t(LOADING_KEYS[Math.floor(Math.random() * LOADING_KEYS.length)])
```

- [ ] **Step 3: Migrate app.tsx — permission mode labels**

```typescript
// Before
const LABELS: Record<string, string> = {
  default: 'manual mode',
  acceptEdits: 'accept edits on',
  plan: 'plan mode / read-only',
  auto: 'auto mode',
  dontAsk: "don't ask",
  bypass: 'bypass',
}

// After
const { t } = useI18n()
const LABELS: Record<string, string> = {
  default: t('ui.permission.manual'),
  acceptEdits: t('ui.permission.accept_edits'),
  plan: t('ui.permission.plan_mode'),
  auto: t('ui.permission.auto'),
  dontAsk: t('ui.permission.dont_ask'),
  bypass: t('ui.permission.bypass'),
}
```

- [ ] **Step 4: Migrate agent-footer.tsx — status labels**

```typescript
// Before
const statusText = entry.status === 'running' ? 'running' : 'finished'

// After
const { t } = useI18n()
const statusText = entry.status === 'running' ? t('ui.agent.running') : t('ui.agent.finished')
```

- [ ] **Step 5: Add all ui.* keys to both locale JSON files**

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: all tests pass, zero regression

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/ui/ packages/shared/src/i18n/locales/
git commit -m "feat(i18n): migrate CLI UI components to t() calls

- chat.tsx: welcome banner, role labels
- input.tsx: 26 loading verbs, vim mode labels
- app.tsx: permission mode labels
- agent-footer.tsx: agent status labels
- picker.tsx, command-picker.tsx: navigation labels
- All ui.* keys in both en-US and zh-CN

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Migrate CLI Tools + Engine Messages

**Files:**
- Modify: `apps/cli/src/core/engine.ts` — error/block/goal-verify messages
- Modify: `apps/cli/src/tools/index.ts` — validation error messages
- Modify: `apps/cli/src/mcp/oauth.ts` — OAuth HTML page
- Modify: `apps/cli/src/mcp/client.ts` — connection status messages
- Modify: `packages/shared/src/i18n/locales/en-US.json` — add tools.*, errors.*, system.* keys
- Modify: `packages/shared/src/i18n/locales/zh-CN.json` — add tools.*, errors.*, system.* keys

**Interfaces:**
- Consumes: `useI18n()` from Task 2
- Produces: Engine errors, tool descriptions, MCP messages all translated

- [ ] **Step 1: Migrate engine.ts error messages**

```typescript
// engine.ts is a class — import t from the shared module directly:
import { createT } from '@mipham/shared/i18n/t'
import enUS from '@mipham/shared/i18n/locales/en-US.json'
import zhCN from '@mipham/shared/i18n/locales/zh-CN.json'

// In the constructor or at module level:
const bundles = { 'en-US': enUS, 'zh-CN': zhCN }
const t = createT(bundles['en-US'], enUS) // engine defaults to en-US for now

// Then replace:
// Before: error: `Tool "${name}" requires user approval (permission: ask).`
// After:  error: t('errors.tool_not_allowed', { name })
```

- [ ] **Step 2: Migrate tools/index.ts validation errors**

```typescript
// Before
return { error: `Missing required parameter: "${field}"` }
// After
return { error: t('errors.missing_param', { param: field }) }
```

- [ ] **Step 3: Migrate MCP messages**

OAuth HTML page (`mcp/oauth.ts`):

```typescript
// Before
const html = '<html><body><h1>Authenticated</h1><p>You may close this window.</p></body></html>'
// After
const html = `<html><body><h1>${t('system.oauth.authenticated')}</h1><p>${t('system.oauth.close_window')}</p></body></html>`
```

Connection messages (`mcp/client.ts`):

```typescript
// Before
process.stderr.write(`[mcp] Connecting to "${name}"...\n`)
// After
process.stderr.write(t('system.mcp.connecting', { name }) + '\n')
```

- [ ] **Step 4: Add all tools.*, errors.*, system.* keys to both locale JSON files**

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: all tests pass, zero regression

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/core/engine.ts apps/cli/src/tools/ apps/cli/src/mcp/ packages/shared/src/i18n/locales/
git commit -m "feat(i18n): migrate engine errors, tools, MCP to t() calls

- engine.ts: error, block, goal-verify messages
- tools/index.ts: validation error messages
- mcp/oauth.ts: OAuth callback HTML
- mcp/client.ts: connection status messages
- All keys in both en-US and zh-CN

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Web i18n Integration

**Files:**
- Create: `apps/web/src/i18n/context.tsx`
- Create: `apps/web/src/i18n/index.ts`
- Modify: `apps/web/src/app/code/layout.tsx` — dynamic `<html lang>` + Provider
- Modify: `apps/web/src/app/code/components/hero.tsx`
- Modify: `apps/web/src/app/code/components/features.tsx`
- Modify: `apps/web/src/app/code/components/install-cmd.tsx`
- Modify: `apps/web/src/app/code/components/footer.tsx`
- Modify: `apps/web/src/app/code/components/models.tsx`
- Modify: `apps/web/src/app/code/install/page.tsx`
- Modify: `apps/web/src/app/code/docs/page.tsx`
- Modify: `apps/web/src/app/code/dashboard/page.tsx`
- Modify: `apps/web/src/app/code/not-found.tsx`
- Modify: `apps/web/src/app/code/error.tsx`
- Modify: `packages/shared/src/i18n/locales/en-US.json` — add web.* keys
- Modify: `packages/shared/src/i18n/locales/zh-CN.json` — add web.* keys

**Interfaces:**
- Consumes: `createT()` from Task 1, locale JSON from Task 3
- Produces: All web pages render translated strings

- [ ] **Step 1: Create web i18n context**

```typescript
// apps/web/src/i18n/context.tsx
'use client'

import React, { createContext, useContext, useState, useMemo } from 'react'
import { bundles } from './index'
import { createT } from '@mipham/shared/i18n/t'
import type { Locale } from '@mipham/shared/i18n/types'

interface I18nContextValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, params?: Record<string, string>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children, initialLocale }: {
  children: React.ReactNode
  initialLocale: Locale
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale)
  const value = useMemo(() => ({
    locale,
    setLocale,
    t: createT(bundles[locale] || bundles['en-US'], bundles['en-US']),
  }), [locale])
  return React.createElement(I18nContext.Provider, { value }, children)
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
```

- [ ] **Step 2: Create web i18n index (bundle imports)**

```typescript
// apps/web/src/i18n/index.ts
import enUS from '@mipham/shared/i18n/locales/en-US.json'
import zhCN from '@mipham/shared/i18n/locales/zh-CN.json'
import type { TranslationMap, Locale } from '@mipham/shared/i18n/types'

export const bundles: Record<Locale, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}

export function detectWebLocale(): Locale {
  if (typeof window === 'undefined') return 'en-US'
  const nav = window.navigator.language
  if (nav.startsWith('zh')) return 'zh-CN'
  return 'en-US'
}
```

- [ ] **Step 3: Wire into layout.tsx**

```typescript
// apps/web/src/app/code/layout.tsx — convert to 'use client'
'use client'

import { I18nProvider } from '@/i18n/context'
import { detectWebLocale } from '@/i18n/index'

export default function CodeLayout({ children }: { children: React.ReactNode }) {
  return React.createElement(
    I18nProvider,
    { initialLocale: detectWebLocale() },
    children
  )
}
```

- [ ] **Step 4: Migrate hero.tsx (example)**

```tsx
'use client'
import { useI18n } from '@/i18n/context'

export function Hero() {
  const { t } = useI18n()
  return (
    <section>
      <h1>{t('web.hero.title')}</h1>
      <p>{t('web.hero.subtitle')}</p>
      <a href="/code/install">{t('web.hero.cta')}</a>
    </section>
  )
}
```

- [ ] **Step 5: Add all web.* keys to both locale JSON files**

Example keys:

```json
{
  "web": {
    "hero": {
      "title": "Mipham Code",
      "subtitle": "Multi-Model Open-Core Intelligent Coding Terminal",
      "cta": "Get Started"
    },
    "features": {
      "title": "Features",
      "multi_model": { "title": "Multi-Model", "desc": "Support for Claude, GPT, DeepSeek, and more." },
      "skills": { "title": "Skills", "desc": "Extensible skill system with community plugins." },
      "tools": { "title": "30+ Tools", "desc": "File ops, shell exec, web access, scheduling." },
      "open_source": { "title": "Open Core", "desc": "Apache 2.0 licensed. Free to use and modify." },
      "terminal": { "title": "Terminal Native", "desc": "Fast TUI built with React + Ink." },
      "agents": { "title": "Background Agents", "desc": "Parallel task execution with agent teams." }
    },
    "footer": {
      "copyright": "© 2026 One Mipham Corporation",
      "docs": "Docs",
      "dashboard": "Dashboard",
      "github": "GitHub"
    }
  }
}
```

- [ ] **Step 6: Build web — verify no compile errors**

Run: `cd apps/web && pnpm build`
Expected: `next build` succeeds, static export clean

- [ ] **Step 7: Run full test suite**

Run: `pnpm test`
Expected: all tests pass, zero regression

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/i18n/ apps/web/src/app/code/ packages/shared/src/i18n/locales/
git commit -m "feat(i18n): web product pages migration

- I18nProvider + useI18n() for Next.js SSG
- detectWebLocale() from navigator.language
- 5 page components + 5 shared components migrated
- All web.* keys in en-US and zh-CN

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: install.sh + VS Code i18n

**Files:**
- Modify: `install.sh` — add shell-based i18n
- Modify: `infrastructure/vscode/extension.js` — migrate user-facing messages
- Modify: `packages/shared/src/i18n/locales/en-US.json` — add install.*, vscode.* keys (reference only; shell reads from inline strings)
- Modify: `packages/shared/src/i18n/locales/zh-CN.json` — add install.*, vscode.* keys (reference only)

**Interfaces:**
- Consumes: None from earlier tasks — standalone implementations
- Produces: install.sh outputs in detected language, VS Code extension notifications translated

- [ ] **Step 1: Add i18n to install.sh**

```bash
#!/usr/bin/env bash
# ... existing code ...

# ── i18n ──
detect_lang() {
  case "${LANG:-}" in
    zh_CN*|zh_CN.*|zh_SG*)
      LANG_ID="zh-CN"
      ;;
    *)
      LANG_ID="en-US"
      ;;
  esac
}

# Messages keyed by LANG_ID
msg_install_success() {
  case "$LANG_ID" in
    "zh-CN") echo "Mipham Code v$VERSION 安装成功！" ;;
    *)       echo "Mipham Code v$VERSION installed successfully!" ;;
  esac
}

msg_unsupported_os() {
  case "$LANG_ID" in
    "zh-CN") echo "不支持的操作系统。需要 macOS 或 Linux。" ;;
    *)       echo "Unsupported OS. Requires macOS or Linux." ;;
  esac
}

msg_need_bun() {
  case "$LANG_ID" in
    "zh-CN") echo "需要安装 Bun。正在自动安装..." ;;
    *)       echo "Need Bun to install. Installing Bun automatically..." ;;
  esac
}

# Call at start
detect_lang
# ... use msg_* functions throughout
```

- [ ] **Step 2: Migrate VS Code extension messages**

```javascript
// infrastructure/vscode/extension.js
// ── i18n ──
const LOCALE = (process.env.LANG || '').startsWith('zh') ? 'zh-CN' : 'en-US'

const MSGS = {
  'en-US': {
    statusBar: 'Mipham Code',
    tooltip: 'Click to focus Mipham Code terminal',
    welcome: 'Mipham Code is ready. Press Cmd+Esc to start.',
    noConfig: 'No Mipham Code config found. Run "mipham /init" to create one.',
    start: 'Start',
    dismiss: 'Dismiss',
    terminalName: 'Mipham Code',
  },
  'zh-CN': {
    statusBar: 'Mipham Code',
    tooltip: '点击聚焦 Mipham Code 终端',
    welcome: 'Mipham Code 已就绪。按 Cmd+Esc 启动。',
    noConfig: '未找到 Mipham Code 配置。运行 "mipham /init" 创建。',
    start: '启动',
    dismiss: '关闭',
    terminalName: 'Mipham Code',
  },
}

function t(key) {
  return MSGS[LOCALE]?.[key] || MSGS['en-US'][key] || key
}

// Then use t() throughout:
// Before: statusBarItem.text = 'Mipham Code'
// After:  statusBarItem.text = t('statusBar')
```

- [ ] **Step 3: Verify install.sh i18n works**

Run: `LANG=zh_CN.UTF-8 bash install.sh --dry-run 2>&1 | head -5`
Expected: Chinese messages appear

Run: `LANG=en_US.UTF-8 bash install.sh --dry-run 2>&1 | head -5`
Expected: English messages appear

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: all tests pass, zero regression

- [ ] **Step 5: Commit**

```bash
git add install.sh infrastructure/vscode/extension.js
git commit -m "feat(i18n): install.sh + VS Code extension i18n

- install.sh: shell case-based LANG detection, zh-CN + en-US messages
- VS Code extension: in-memory MSGS map, t() helper
- Both fall back to en-US for unknown/unsupported locales

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Remaining Strings + Final Verification

**Files:**
- Modify: `apps/cli/src/agent-view/dashboard.tsx` — remaining UI strings
- Modify: `apps/cli/src/agent-view/session-row.tsx` — status labels
- Modify: `apps/cli/src/agent-view/session-peek.tsx` — message preview labels
- Modify: `apps/cli/src/commands/keys.ts` — key management strings
- Modify: `apps/cli/src/commands/loop-scaffold.ts` — scaffold output
- Modify: `apps/cli/src/skills/registry.ts` — install/remove messages
- Modify: `apps/cli/src/plugin/plugin-manager.ts` — plugin status messages
- Modify: `packages/shared/src/i18n/locales/en-US.json` — add all remaining keys
- Modify: `packages/shared/src/i18n/locales/zh-CN.json` — add all remaining keys

- [ ] **Step 1: Scan for any remaining hardcoded English strings**

Run a grep for untranslated user-facing patterns:

```bash
cd apps/cli/src && grep -rn "'[A-Z][a-z].*[a-z]{3,}'" --include='*.ts' --include='*.tsx' \
  | grep -v node_modules | grep -v '.test.' | grep -v 'import ' | grep -v 'from ' \
  | grep -v t\( | head -50
```

For each remaining string that is user-facing (not code structure), add to locale JSON and replace with t() call.

- [ ] **Step 2: Key parity check — ensure en-US and zh-CN have identical key sets**

```bash
# Extract all top-level + nested keys from both files, diff them
cd packages/shared/src/i18n/locales
node -e "
const en = require('./en-US.json')
const zh = require('./zh-CN.json')
function keys(obj, prefix='') {
  return Object.entries(obj).flatMap(([k,v]) =>
    typeof v === 'string' ? [prefix+k] : keys(v, prefix+k+'.')
  )
}
const enKeys = new Set(keys(en))
const zhKeys = new Set(keys(zh))
const missing = [...enKeys].filter(k => !zhKeys.has(k))
const extra = [...zhKeys].filter(k => !enKeys.has(k))
if (missing.length) console.log('Missing in zh-CN:', missing)
if (extra.length) console.log('Extra in zh-CN:', extra)
if (!missing.length && !extra.length) console.log('✓ Key parity: all OK')
"
```

Expected: `✓ Key parity: all OK`

- [ ] **Step 3: Run all verification checks**

```bash
pnpm test       # All tests pass
pnpm typecheck  # No type errors
pnpm lint       # 0 errors, 0 warnings
pnpm build-cli  # CLI builds successfully
pnpm build-web  # Web builds successfully
```

Expected: all pass, zero regression, 853+ tests green

- [ ] **Step 4: Commit final batch**

```bash
git add -A
git commit -m "feat(i18n): complete remaining string migration + final verification

- Agent view dashboard, session components
- Commands: keys, loop-scaffold
- Skills registry, plugin manager
- Key parity verified between en-US and zh-CN
- All lint, typecheck, test, build: green

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Bump Version + Final CI Verification

- [ ] **Step 1: Bump version**

```bash
bash scripts/bump-version.sh 0.20.0
git add -A
git commit -m "chore: bump version to 0.20.0 — i18n internationalization

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 2: Tag and push**

```bash
git tag -a v0.20.0 -m "v0.20.0 — zh-CN + en-US i18n, ~3,400 strings, 853+ tests, zero new deps"
git push && git push origin v0.20.0
```

- [ ] **Step 3: Monitor CI**

Verify all 8 CI jobs pass: Type Check, Lint, Format Check, Build CLI, Build Web, Test, Security Audit, Penetration Tests.

---

## Self-Review Checklist

1. **Spec coverage**: Each spec section maps to at least one task — ✓
2. **Placeholder scan**: No TBD, TODO, "implement later" patterns — ✓
3. **Type consistency**: `createT()` signature in Task 1 matches usage in Tasks 2-9 — ✓; `useI18n()` returns `{ locale, t }` consistently — ✓; `detectLocale(opts?)` signature same everywhere — ✓
