# Tier 3 Experience & Ecosystem — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver four Tier-3 experience/ecosystem subsystems (Plugins, Artifacts SSE+versioning, Computer Use, Vim/Safe/Goal) as defined in `docs/superpowers/specs/2026-07-11-tier3-experience-ecosystem-design.md`.

**Architecture:** Four independent subsystems, any order. Each extends existing infrastructure (MCP for Plugins, artifact server for Artifacts, tools layer for Computer Use, UI input for Vim motions).

**Tech Stack:** TypeScript 5.5+ strict, Bun runtime, React 18 + Ink 5 (TUI), Vitest 3, Playwright (Computer Use browser layer)

## Global Constraints

- TypeScript strict mode, ESM modules
- All existing 483 tests (Tier 1 + Tier 2) must continue to pass
- Backward compatible: no breaking changes
- Commit messages follow Conventional Commits
- Base branch: `feat/tier1-core-capabilities`

---

## Phase 1: Vim Motions + Safe Mode + /goal (quick wins)

### Task 1.1: Vim Motions in InputBar

**Files:**

- Create: `apps/cli/src/ui/vim-motions.ts`
- Modify: `apps/cli/src/ui/input.tsx`
- Create: `apps/cli/test/ui/vim-motions.test.ts`

- [ ] **Step 1: Implement vim-motions.ts**

```typescript
// apps/cli/src/ui/vim-motions.ts

export type VimMode = 'insert' | 'normal'

export class VimMotionEngine {
  mode: VimMode = 'insert'
  private clipboard = ''
  private undoStack: string[] = []
  private redoStack: string[] = []
  private history: string[] = []
  private historyIdx = -1

  /** Handle a keypress in normal mode. Returns new cursor position delta and any text mutation. */
  handleNormal(key: string, text: string, cursor: number): VimAction | null {
    switch (key) {
      case 'h':
        return { cursor: cursor - 1 }
      case 'l':
        return { cursor: cursor + 1 }
      case '0':
        return { cursor: 0 }
      case '$':
        return { cursor: text.length }
      case 'w':
        return { cursor: this.nextWord(text, cursor) }
      case 'b':
        return { cursor: this.prevWord(text, cursor) }
      case 'd':
        return { pending: 'd' }
      case 'y':
        return { pending: 'y' }
      default:
        return null
    }
  }

  /** Handle dd — delete entire line */
  handleDD(text: string): VimAction {
    this.clipboard = text
    this.pushUndo(text)
    return { text: '', cursor: 0 }
  }

  /** Handle yy — yank entire line */
  handleYY(text: string): VimAction {
    this.clipboard = text
    return { cursor: 0 } // no change
  }

  /** Handle p — paste after cursor */
  handlePaste(text: string, cursor: number): VimAction {
    const newText = text.slice(0, cursor) + this.clipboard + text.slice(cursor)
    this.pushUndo(text)
    return { text: newText, cursor: cursor + this.clipboard.length }
  }

  /** Handle u — undo */
  handleUndo(text: string): VimAction {
    const prev = this.undoStack.pop()
    if (prev !== undefined) {
      this.redoStack.push(text)
      return { text: prev, cursor: prev.length }
    }
    return { cursor: text.length }
  }

  /** Handle /search */
  handleSearch(text: string, query: string): VimAction {
    const idx = text.indexOf(query)
    return idx >= 0 ? { cursor: idx } : { cursor: 0 }
  }

  /** Repeat last f/F/t/T motion */
  handleRepeat(text: string, lastFind: string, cursor: number): VimAction {
    const idx = text.indexOf(lastFind, cursor + 1)
    return idx >= 0 ? { cursor: idx } : { cursor }
  }

  private nextWord(text: string, cursor: number): number {
    // Skip word characters, then skip whitespace
    let i = cursor
    while (i < text.length && text[i] !== ' ') i++
    while (i < text.length && text[i] === ' ') i++
    return i
  }

  private prevWord(text: string, cursor: number): number {
    let i = cursor - 1
    while (i > 0 && text[i] === ' ') i--
    while (i > 0 && text[i] !== ' ') i--
    return i > 0 ? i + 1 : 0
  }

  private pushUndo(text: string): void {
    this.undoStack.push(text)
    if (this.undoStack.length > 50) this.undoStack.shift()
  }
}

export interface VimAction {
  text?: string
  cursor?: number
  pending?: string
}
```

- [ ] **Step 2: Integrate into InputBar**

In `apps/cli/src/ui/input.tsx`, add Vim mode toggling on Escape and dispatch normal-mode keys through `VimMotionEngine`.

- [ ] **Step 3: Tests and commit**

```bash
cd apps/cli && bun test test/ui/vim-motions.test.ts
git add apps/cli/src/ui/vim-motions.ts apps/cli/src/ui/input.tsx
git commit -m "feat(ui): add Vim motions (hjkl, w/b, dd, yy, p, u, /)"
```

---

### Task 1.2: Safe Mode + /goal

**Files:**

- Modify: `apps/cli/bin/mipham.ts`
- Modify: `apps/cli/src/core/engine.ts`
- Modify: `apps/cli/src/ui/commands.ts`

- [ ] **Step 1: Safe Mode in bin/mipham.ts**

```typescript
// Parse --safe-mode flag in commander setup:
program.option('--safe-mode', 'Launch with all customizations disabled')

// In the action handler:
if (opts.safeMode) {
  // Skip loading: ~/.mipham/ agents, skills, hooks, plugins
  // Only use built-in defaults
  process.env.MIPHAM_SAFE_MODE = '1'
}
```

- [ ] **Step 2: /goal command in engine.ts**

```typescript
// In QueryEngine:
private goal?: string
private maxGoalLoops = 20

setGoal(goal: string): void { this.goal = goal }

async *processWithGoal(input: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
  let loop = 0
  while (loop < this.maxGoalLoops) {
    yield* this.process(input, signal)
    loop++

    if (!this.goal) break

    // Ask AI to check the goal condition
    const checkMsg = `Has this goal been achieved? "${this.goal}" Answer YES or NO with reason.`
    yield* this.process(checkMsg, signal)
    // If AI responds "YES", break
    if (this.lastAssistantContent?.includes('YES')) break
  }
}
```

- [ ] **Step 3: /goal slash command in commands.ts**

```typescript
{
  name: '/goal',
  handler: async (ctx, args) => {
    ctx.engine.setGoal(args)
    return { content: `Goal set: "${args}". Working until achieved...` }
  }
}
```

- [ ] **Step 4: Tests and commit**

```bash
cd apps/cli && bun test test/core/engine.test.ts
git add apps/cli/bin/mipham.ts apps/cli/src/core/engine.ts apps/cli/src/ui/commands.ts
git commit -m "feat: add --safe-mode flag and /goal command"
```

---

## Phase 2: Plugins System

### Task 2.1: Plugin Manager

**Files:**

- Create: `apps/cli/src/plugin/plugin-manager.ts`
- Create: `apps/cli/src/plugin/plugin-loader.ts`
- Create: `apps/cli/src/plugin/plugin-validator.ts`
- Create: `apps/cli/test/plugin/plugin-manager.test.ts`

- [ ] **Step 1: Plugin validation**

```typescript
// apps/cli/src/plugin/plugin-validator.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface PluginManifest {
  name: string
  version: string
  miphamVersion?: string
  hooks?: Record<string, unknown>
}

export function validatePlugin(dir: string): {
  valid: boolean
  errors: string[]
  manifest?: PluginManifest
} {
  const errors: string[] = []

  try {
    const raw = readFileSync(join(dir, 'plugin.json'), 'utf-8')
    const manifest = JSON.parse(raw) as PluginManifest

    if (!manifest.name || !/^[a-z0-9-]+$/.test(manifest.name)) {
      errors.push('Invalid plugin name: must be lowercase alphanumeric with hyphens')
    }
    if (!manifest.version) {
      errors.push('Missing required field: version')
    }

    // Check for suspicious hooks
    if (manifest.hooks) {
      const hooksStr = JSON.stringify(manifest.hooks)
      if (hooksStr.includes('rm -rf') || hooksStr.includes('curl') || hooksStr.includes('eval')) {
        errors.push('Suspicious hook commands detected — manual review required')
      }
    }

    return { valid: errors.length === 0, errors, manifest }
  } catch (err) {
    return { valid: false, errors: [`Failed to read plugin.json: ${String(err)}`] }
  }
}
```

- [ ] **Step 2: Plugin manager**

```typescript
// apps/cli/src/plugin/plugin-manager.ts
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { validatePlugin } from './plugin-validator'

const PLUGIN_DIR = join(homedir(), '.mipham', 'plugins')

interface InstalledPlugin {
  name: string
  version: string
  path: string
  enabled: boolean
  installedAt: string
}

export class PluginManager {
  private plugins: InstalledPlugin[] = []
  private statePath: string

  constructor() {
    mkdirSync(PLUGIN_DIR, { recursive: true })
    this.statePath = join(PLUGIN_DIR, 'state.json')
    this.loadState()
  }

  install(sourcePath: string): { success: boolean; message: string } {
    const validation = validatePlugin(sourcePath)
    if (!validation.valid || !validation.manifest) {
      return { success: false, message: validation.errors.join('; ') }
    }

    const destDir = join(PLUGIN_DIR, validation.manifest.name)
    if (existsSync(destDir)) {
      return {
        success: false,
        message: `Plugin "${validation.manifest.name}" is already installed`,
      }
    }

    // Copy plugin directory
    mkdirSync(destDir, { recursive: true })
    this.copyDir(sourcePath, destDir)

    this.plugins.push({
      name: validation.manifest.name,
      version: validation.manifest.version,
      path: destDir,
      enabled: true,
      installedAt: new Date().toISOString(),
    })

    this.saveState()
    return {
      success: true,
      message: `Plugin "${validation.manifest.name}" v${validation.manifest.version} installed`,
    }
  }

  list(): InstalledPlugin[] {
    return [...this.plugins]
  }

  remove(name: string): boolean {
    const plugin = this.plugins.find((p) => p.name === name)
    if (!plugin) return false
    try {
      rmSync(plugin.path, { recursive: true, force: true })
    } catch {}
    this.plugins = this.plugins.filter((p) => p.name !== name)
    this.saveState()
    return true
  }

  enable(name: string): boolean {
    const p = this.plugins.find((p) => p.name === name)
    if (!p) return false
    p.enabled = true
    this.saveState()
    return true
  }

  disable(name: string): boolean {
    const p = this.plugins.find((p) => p.name === name)
    if (!p) return false
    p.enabled = false
    this.saveState()
    return true
  }

  getEnabled(): InstalledPlugin[] {
    return this.plugins.filter((p) => p.enabled)
  }

  private copyDir(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name)
      const destPath = join(dest, entry.name)
      if (entry.isDirectory()) this.copyDir(srcPath, destPath)
      else {
        const content = readFileSync(srcPath)
        writeFileSync(destPath, content)
      }
    }
  }

  private loadState(): void {
    try {
      if (existsSync(this.statePath)) {
        this.plugins = JSON.parse(readFileSync(this.statePath, 'utf-8'))
      }
    } catch {
      this.plugins = []
    }
  }

  private saveState(): void {
    writeFileSync(this.statePath, JSON.stringify(this.plugins, null, 2), 'utf-8')
  }
}
```

- [ ] **Step 3: Plugin loader (wire into engine/app)**

```typescript
// apps/cli/src/plugin/plugin-loader.ts
import { PluginManager } from './plugin-manager'
import { join } from 'node:path'

export function loadPlugins(
  pluginManager: PluginManager,
  engine: unknown,
  skillsLoader: unknown,
): void {
  for (const plugin of pluginManager.getEnabled()) {
    // Load custom agents
    const agentsDir = join(plugin.path, 'agents')
    // → register with AgentRegistry

    // Load custom skills
    const skillsDir = join(plugin.path, 'skills')
    // → register with SkillsLoader

    // Load MCP servers
    const mcpDir = join(plugin.path, 'mcp-servers')
    // → register MCP configs

    // Load hooks
    // → parse plugin.json hooks → register with HookEngine
  }
}
```

- [ ] **Step 4: CLI commands in bin/mipham.ts**

```bash
mipham plugin install <path>
mipham plugin list
mipham plugin remove <name>
mipham plugin enable <name>
mipham plugin disable <name>
```

- [ ] **Step 5: Tests and commit**

```bash
cd apps/cli && bun test test/plugin/plugin-manager.test.ts
git add apps/cli/src/plugin/ apps/cli/test/plugin/ apps/cli/bin/mipham.ts
git commit -m "feat(plugin): add plugin manager with install/list/remove/enable/disable"
```

---

## Phase 3: Artifacts Enhancement

### Task 3.1: SSE + Versioning for Artifacts

**Files:**

- Modify: `apps/cli/src/artifacts/server.ts`
- Create: `apps/cli/src/artifacts/versioning.ts`
- Create: `apps/cli/test/artifacts/versioning.test.ts`

- [ ] **Step 1: Versioning system**

```typescript
// apps/cli/src/artifacts/versioning.ts
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const VERSIONS_DIR = join(homedir(), '.mipham', 'artifacts')

interface ArtifactVersion {
  name: string
  version: number
  path: string
  createdAt: string
  size: number
}

export class ArtifactVersioning {
  private dir: string

  constructor() {
    this.dir = VERSIONS_DIR
    mkdirSync(this.dir, { recursive: true })
  }

  /** Save a new version of an artifact. Returns version number. */
  saveVersion(name: string, content: string): number {
    const artifactDir = join(this.dir, name)
    const versionsDir = join(artifactDir, 'versions')
    mkdirSync(versionsDir, { recursive: true })

    // Get next version number
    const existing = this.listVersions(name)
    const nextVersion = (existing.length > 0 ? Math.max(...existing.map((v) => v.version)) : 0) + 1

    // Save version file
    const versionPath = join(versionsDir, `v${nextVersion}.html`)
    writeFileSync(versionPath, content, 'utf-8')

    // Update current.html symlink/reference
    writeFileSync(join(artifactDir, 'current.html'), content, 'utf-8')
    // Update manifest
    writeFileSync(
      join(artifactDir, 'manifest.json'),
      JSON.stringify(
        {
          name,
          currentVersion: nextVersion,
          versionCount: nextVersion,
        },
        null,
        2,
      ),
    )

    return nextVersion
  }

  listVersions(name: string): ArtifactVersion[] {
    const versionsDir = join(this.dir, name, 'versions')
    if (!existsSync(versionsDir)) return []

    try {
      return readdirSync(versionsDir)
        .filter((f) => f.startsWith('v') && f.endsWith('.html'))
        .map((f) => {
          const vNum = parseInt(f.replace('v', '').replace('.html', ''), 10)
          const path = join(versionsDir, f)
          return {
            name,
            version: vNum,
            path,
            createdAt: '',
            size: 0, // populated from stat
          }
        })
        .sort((a, b) => b.version - a.version)
    } catch {
      return []
    }
  }

  getVersion(name: string, version?: number): string | null {
    const artifactDir = join(this.dir, name)
    if (version) {
      const vPath = join(artifactDir, 'versions', `v${version}.html`)
      return existsSync(vPath) ? readFileSync(vPath, 'utf-8') : null
    }
    const currentPath = join(artifactDir, 'current.html')
    return existsSync(currentPath) ? readFileSync(currentPath, 'utf-8') : null
  }

  /** Get a simple text diff between two versions */
  diff(name: string, v1: number, v2: number): string {
    const content1 = this.getVersion(name, v1) || ''
    const content2 = this.getVersion(name, v2) || ''
    const lines1 = content1.split('\n')
    const lines2 = content2.split('\n')

    const diffLines: string[] = []
    const maxLen = Math.max(lines1.length, lines2.length)
    for (let i = 0; i < maxLen; i++) {
      if (lines1[i] !== lines2[i]) {
        if (lines1[i] !== undefined) diffLines.push(`- ${lines1[i]}`)
        if (lines2[i] !== undefined) diffLines.push(`+ ${lines2[i]}`)
      }
    }
    return diffLines.length > 0 ? diffLines.join('\n') : '(no changes)'
  }
}
```

- [ ] **Step 2: Add SSE endpoint to artifact server**

```typescript
// In apps/cli/src/artifacts/server.ts, add SSE route:

// GET /:name/sse — Server-Sent Events for real-time updates
server.get('/:name/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  const name = req.params.name
  const interval = setInterval(() => {
    const content = versioning.getVersion(name)
    if (content) {
      res.write(`data: ${JSON.stringify({ type: 'update', name, content })}\n\n`)
    }
  }, 500) // check every 500ms

  req.on('close', () => clearInterval(interval))
})
```

- [ ] **Step 3: Tests and commit**

```bash
cd apps/cli && bun test test/artifacts/versioning.test.ts
git add apps/cli/src/artifacts/ apps/cli/test/artifacts/
git commit -m "feat(artifacts): add SSE real-time updates and version snapshots"
```

---

## Phase 4: Computer Use

### Task 4.1: Screenshot + App Launch + Browser Automation

**Files:**

- Create: `apps/cli/src/tools/computer/computer-use.ts`
- Create: `apps/cli/src/tools/computer/screenshot.ts`
- Create: `apps/cli/src/tools/computer/app-launcher.ts`
- Create: `apps/cli/src/tools/computer/browser.ts`
- Create: `apps/cli/test/tools/computer/computer-use.test.ts`

- [ ] **Step 1: Cross-platform screenshot**

```typescript
// apps/cli/src/tools/computer/screenshot.ts
import { execSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function takeScreenshot(): Promise<{
  success: boolean
  data?: string
  error?: string
}> {
  const tmpPath = join(tmpdir(), `mipham-screenshot-${Date.now()}.png`)

  try {
    const platform = process.platform
    if (platform === 'darwin') {
      execSync(`screencapture -x ${tmpPath}`, { timeout: 10000 })
    } else if (platform === 'linux') {
      execSync(`import -window root ${tmpPath}`, { timeout: 10000 })
    } else if (platform === 'win32') {
      // PowerShell ScreenCapture
      execSync(
        `powershell -Command "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Screen]::AllScreens[0].Bounds | Export-Clixml -Path tmp.xml"`,
        { timeout: 10000 },
      )
    }

    const data = readFileSync(tmpPath, 'base64')
    try {
      unlinkSync(tmpPath)
    } catch {}
    return { success: true, data: `data:image/png;base64,${data}` }
  } catch (err) {
    return { success: false, error: `Screenshot failed: ${String(err)}` }
  }
}
```

- [ ] **Step 2: App launcher**

```typescript
// apps/cli/src/tools/computer/app-launcher.ts
import { execSync } from 'node:child_process'

const ALLOWED_APPS = new Set([
  'Finder',
  'Safari',
  'Google Chrome',
  'Firefox',
  'Terminal',
  'VS Code',
  'System Settings',
  'Activity Monitor',
  'TextEdit',
  'Preview',
])

export function launchApp(appName: string): { success: boolean; message: string } {
  if (!ALLOWED_APPS.has(appName)) {
    return {
      success: false,
      message: `App "${appName}" is not in the allowed list. Allowed: ${[...ALLOWED_APPS].join(', ')}`,
    }
  }

  try {
    const platform = process.platform
    if (platform === 'darwin') {
      execSync(`open -a "${appName}"`, { timeout: 5000 })
    } else if (platform === 'linux') {
      execSync(`xdg-open "${appName}"`, { timeout: 5000 })
    } else if (platform === 'win32') {
      execSync(`start "${appName}"`, { timeout: 5000, shell: true })
    }
    return { success: true, message: `Launched: ${appName}` }
  } catch (err) {
    return { success: false, message: `Failed to launch ${appName}: ${String(err)}` }
  }
}
```

- [ ] **Step 3: Browser automation (Playwright-based)**

```typescript
// apps/cli/src/tools/computer/browser.ts

let browserPromise: Promise<unknown> | null = null

async function getPage(): Promise<unknown> {
  if (!browserPromise) {
    // Dynamic import — Playwright is optional
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: false })
    browserPromise = browser.newPage()
  }
  return browserPromise
}

export async function browserNavigate(url: string): Promise<string> {
  const page = (await getPage()) as { goto: (u: string) => Promise<void>; url: () => string }
  await page.goto(url)
  return `Navigated to: ${page.url()}`
}

export async function browserSnapshot(): Promise<string> {
  const page = (await getPage()) as { accessibility: { snapshot: () => Promise<unknown> } }
  const snapshot = await page.accessibility.snapshot()
  return JSON.stringify(snapshot, null, 2)
}

export async function browserClick(uid: string): Promise<string> {
  const page = (await getPage()) as { locator: (s: string) => { click: () => Promise<void> } }
  await page.locator(`[uid="${uid}"]`).click()
  return `Clicked: ${uid}`
}
```

- [ ] **Step 4: Register ComputerUse tool**

```typescript
// apps/cli/src/tools/computer/computer-use.ts
import type { ToolDefinition } from '../../shared/index.ts'
import { takeScreenshot } from './screenshot'
import { launchApp } from './app-launcher'
import { browserNavigate, browserSnapshot, browserClick } from './browser'

export const computerUseTool: ToolDefinition = {
  name: 'ComputerUse',
  description:
    'Take screenshots, launch apps, or control a browser. Always requires user approval.',
  category: 'system',
  permission: 'ask', // ALWAYS ask — security requirement
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['screenshot', 'launch', 'browser_navigate', 'browser_snapshot', 'browser_click'],
      },
      target: { type: 'string', description: 'App name, URL, or element UID' },
      text: { type: 'string', description: 'Text to type (for browser_type)' },
    },
    required: ['action'],
  },
  async execute(params) {
    const action = params.action as string
    const target = (params.target as string) || ''

    switch (action) {
      case 'screenshot': {
        const result = await takeScreenshot()
        return result.success
          ? { success: true, content: `Screenshot captured: ${result.data!.slice(0, 100)}...` }
          : { success: false, content: '', error: result.error }
      }
      case 'launch': {
        const result = launchApp(target)
        return result.success
          ? { success: true, content: result.message }
          : { success: false, content: '', error: result.message }
      }
      case 'browser_navigate': {
        const url = await browserNavigate(target)
        return { success: true, content: url }
      }
      case 'browser_snapshot': {
        const snapshot = await browserSnapshot()
        return { success: true, content: snapshot }
      }
      case 'browser_click': {
        const result = await browserClick(target)
        return { success: true, content: result }
      }
      default:
        return { success: false, content: '', error: `Unknown action: ${action}` }
    }
  },
}
```

- [ ] **Step 5: Register tool + tests + commit**

```bash
# Register computerUseTool in tools/index.ts
cd apps/cli && bun test test/tools/computer/computer-use.test.ts
git add apps/cli/src/tools/computer/ apps/cli/test/tools/computer/ apps/cli/src/tools/index.ts
git commit -m "feat(computer-use): add screenshot, app launch, and browser automation tools"
```

---

## Task 4.5: Final Integration & Verification

- [ ] **Step 1: Run full test suite**

```bash
cd apps/cli && bun test
```

Expected: All 483+ tests pass, 0 new failures.

- [ ] **Step 2: Typecheck**

```bash
cd apps/cli && pnpm typecheck
```

- [ ] **Step 3: Final commit**

```bash
git add -A && git commit -m "feat: Tier 3 — Plugins, Artifacts SSE, Computer Use, Vim/Safe/Goal"
```

---

## Dependency Order

```
Phase 1: Vim/Safe/Goal (quick wins, independent)
Phase 2: Plugins (independent)
Phase 3: Artifacts (independent, extends existing server)
Phase 4: Computer Use (independent, new tool)
Task 4.5: Final Integration
```

All four phases are independent — no cross-phase dependencies.

## Estimated Test Counts

| Test File              | Tests  |
| ---------------------- | ------ |
| vim-motions.test.ts    | 8      |
| plugin-manager.test.ts | 6      |
| versioning.test.ts     | 5      |
| computer-use.test.ts   | 5      |
| **Total new tests**    | **24** |
