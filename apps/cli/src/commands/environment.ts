/**
 * Mipham Code — Environment Slash Commands
 *
 * Extracted from ui/commands.ts (2026-08-06).
 * Handlers for: /release-notes, /ide, /terminal-setup
 */
import type { CommandHandler } from '../ui/commands.js'
import { NPM_INSTALL_COMMAND, PACKAGE_VERSION } from '../shared/index.ts'
import { miphamHome } from '../core/paths.ts'

export { releaseNotesCmd, ideCmd, terminalSetupCmd }

// ═══════════════════════════════════════════════════════════════
// Add-Dir — add a directory to workspace permissions
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Security / Audit — security review checklist
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Release Notes — version changelog
// ═══════════════════════════════════════════════════════════════

const releaseNotesCmd: CommandHandler = () => ({
  content: `── Release Notes ──

Current: Mipham Code v${PACKAGE_VERSION}

This build does not embed the full changelog. See:
  • /changelog                       recent release tags in this clone
  • https://mipham.ai/code/releases  full release notes

Install / upgrade: ${NPM_INSTALL_COMMAND}`,
})

// ═══════════════════════════════════════════════════════════════
// IDE — IDE integration guide
// ═══════════════════════════════════════════════════════════════

const ideCmd: CommandHandler = async (_ctx) => {
  const { mkdirSync } = await import('node:fs')
  const { atomicWriteFileSync } = await import('../shared/atomic-write')
  const { join } = await import('node:path')

  const cwd = process.cwd()
  const vscodeDir = join(cwd, '.vscode')
  mkdirSync(vscodeDir, { recursive: true })

  const files: string[] = []

  // ── Detect bun path ──
  let bunPath = '/opt/homebrew/bin/bun'
  try {
    const { execSync } = await import('node:child_process')
    const detected = execSync('which bun 2>/dev/null || echo /opt/homebrew/bin/bun', {
      encoding: 'utf-8',
    }).trim()
    if (detected) bunPath = detected
  } catch {
    // Use default
  }

  // Write helpers that MERGE instead of clobbering. These are the user's editor
  // settings: overwriting the file to add one profile destroys every other key
  // (and `keybindings.json` is commonly JSONC, so an unparseable file must be
  // left alone rather than replaced).
  const { readRegularFileSync } = await import('../shared/regular-file')
  const readJson = (path: string): unknown => {
    const raw = readRegularFileSync(path)
    if (raw === null) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return undefined // JSONC / hand-edited — refuse to rewrite
    }
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)

  // ── settings.json: terminal profile ──
  const settingsPath = join(vscodeDir, 'settings.json')
  const existingSettings = readJson(settingsPath)
  const settings: Record<string, unknown> = isObject(existingSettings) ? existingSettings : {}
  const profiles = isObject(settings['terminal.integrated.profiles.osx'])
    ? (settings['terminal.integrated.profiles.osx'] as Record<string, unknown>)
    : {}
  profiles.mipham = {
    path: bunPath,
    args: ['run', 'mipham'],
    cwd: '${workspaceFolder}',
  }
  settings['terminal.integrated.profiles.osx'] = profiles
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o644 })
  files.push('.vscode/settings.json')

  // ── keybindings.json: Cmd+Esc launch ──
  const keybindingsPath = join(vscodeDir, 'keybindings.json')
  const existingKeybindings = readJson(keybindingsPath)
  const keybindings: Record<string, unknown>[] = Array.isArray(existingKeybindings)
    ? (existingKeybindings as Record<string, unknown>[])
    : []
  const wanted = [
    {
      key: 'cmd+escape',
      command: 'workbench.action.terminal.focus',
      when: 'terminalProcessSupported',
    },
    {
      key: 'cmd+shift+m',
      command: 'workbench.action.terminal.new',
    },
  ]
  for (const entry of wanted) {
    if (!keybindings.some((k) => k.key === entry.key && k.command === entry.command)) {
      keybindings.push(entry)
    }
  }
  atomicWriteFileSync(keybindingsPath, JSON.stringify(keybindings, null, 2) + '\n', { mode: 0o644 })
  files.push('.vscode/keybindings.json')

  // ── extensions.json: recommended ──
  const extensionsPath = join(vscodeDir, 'extensions.json')
  const existingExtensions = readJson(extensionsPath)
  const extensions: Record<string, unknown> = isObject(existingExtensions) ? existingExtensions : {}
  const recommendations = Array.isArray(extensions.recommendations)
    ? (extensions.recommendations as unknown[])
    : []
  if (!recommendations.includes('miphamai.mipham-code')) {
    recommendations.push('miphamai.mipham-code')
  }
  extensions.recommendations = recommendations
  atomicWriteFileSync(extensionsPath, JSON.stringify(extensions, null, 2) + '\n', { mode: 0o644 })
  files.push('.vscode/extensions.json')

  return {
    content: [
      '── VS Code Integration ──',
      '',
      `Generated in ${vscodeDir}:`,
      ...files.map((f) => `  ✅ ${f}`),
      '',
      'What was configured:',
      '  • Terminal profile "mipham" — opens Mipham Code in integrated terminal',
      '  • Keyboard shortcut Cmd+Esc — focus terminal',
      '  • Cmd+Shift+M — new terminal',
      '',
      'To use:',
      '  1. Restart VS Code (or reload window: Cmd+Shift+P → Reload Window)',
      '  2. Open terminal: Ctrl+` or Cmd+Esc',
      '  3. Select "mipham" profile from the terminal dropdown',
      '',
      'Install the VS Code extension for full integration:',
      `  code --install-extension miphamai.mipham-code`,
      '',
      'JetBrains: Settings → Tools → Terminal → Shell path → bun run mipham',
    ].join('\n'),
  }
}

// ═══════════════════════════════════════════════════════════════
// Terminal Setup — shell integration guide
// ═══════════════════════════════════════════════════════════════

const terminalSetupCmd: CommandHandler = async () => {
  const { existsSync, mkdirSync, readFileSync } = await import('node:fs')
  const { atomicWriteFileSync } = await import('../shared/atomic-write')
  const { appendRegularFileSync } = await import('../shared/regular-file')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const home = homedir()
  const lines: string[] = ['── Terminal Setup ──', '']

  // ── 1. Generate standalone shell setup script ──
  const miphamDir = miphamHome()
  mkdirSync(miphamDir, { recursive: true })

  const shellScript = join(miphamDir, 'shell-setup.sh')
  // 这个文件从前写三样东西，一样都不生效 —— 其中一样还有害：
  //   • `export MIPHAM_HOME=…` —— `miphamHome()` 只用 `homedir()`，从不读这个变量；
  //   • `export MIPHAM_PROVIDER=$(grep …)` —— 全仓库零读者；
  //   • `alias mipham='cd $(pwd) && npm install -g … > /dev/null 2>&1; mipham'` ——
  //     `cd $(pwd)` 是空操作，剩下那半是**每次敲 `mipham` 都静默重装一遍全局包**，
  //     而 `npm install -g` 没有原子换手：中途被打断就一个 CLI 都不剩，且错误全被丢掉。
  // CLI 自己读 `~/.mipham/config.yml`，shell 这边没有什么需要导出的；写清楚这件事，
  // 比塞进三条看着像配置、实则不改任何行为的行更有用。重跑本命令会把旧文件覆盖掉。
  const shellContent = [
    '#!/bin/bash',
    '# Mipham Code — Shell Integration',
    '# Source this file in your shell profile:',
    '#   source ~/.mipham/shell-setup.sh',
    '',
    '# Mipham Code needs no environment variables: the home directory, the default',
    '# provider and the API keys are all read from ~/.mipham/config.yml by the CLI',
    '# itself. The only thing a shell profile may need is PATH to `mipham`, which',
    '# the installer already sets up.',
    '',
    '# Local development build, side by side with the installed one:',
    '# alias mipham-dev="bun run /path/to/mipham-code/apps/cli/bin/mipham"',
  ].join('\n')
  atomicWriteFileSync(shellScript, shellContent + '\n', { mode: 0o644 })
  lines.push(`  ✅ Generated: ${shellScript}`)

  // ── 2. Append to shell profile ──
  const shell = process.env.SHELL || '/bin/zsh'
  const profileName = shell.includes('zsh') ? '.zshrc' : '.bashrc'
  const profilePath = join(home, profileName)
  const sourceLine = `\n# Mipham Code shell integration\n[ -f ~/.mipham/shell-setup.sh ] && source ~/.mipham/shell-setup.sh\n`

  try {
    const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : ''
    if (existing.includes('shell-setup.sh')) {
      lines.push(`  ⏭  ${profileName} already has Mipham Code integration`)
    } else {
      // 写不进去（含 profile 路径上是个 FIFO）就与下面 catch 同路：把命令印给用户。
      if (!appendRegularFileSync(profilePath, sourceLine)) throw new Error('not a regular file')
      lines.push(`  ✅ Added to ~/${profileName}`)
    }
  } catch {
    lines.push(`  ⚠️  Could not update ~/${profileName}. Add manually:`)
    lines.push(`     echo '${sourceLine.trim()}' >> ~/${profileName}`)
  }

  // ── 3. Global install check ──
  lines.push('')
  lines.push('── Installation ──')
  try {
    const { execSync } = await import('node:child_process')
    const miphamPath = execSync('which mipham 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim()
    if (miphamPath) {
      lines.push(`  ✅ mipham found at: ${miphamPath}`)
      const version = execSync('mipham --version 2>/dev/null || echo "unknown"', {
        encoding: 'utf-8',
      }).trim()
      lines.push(`  📦 Version: ${version}`)
    } else {
      lines.push(`  ⚠️  mipham not in PATH. Install globally:`)
      lines.push(`     ${NPM_INSTALL_COMMAND}`)
      lines.push(`     or: curl -fsSL https://mipham.ai/install.sh | bash`)
    }
  } catch {
    lines.push(`  💡 Install: ${NPM_INSTALL_COMMAND}`)
  }

  // ── 4. Verify ──
  lines.push('')
  lines.push('── Next Steps ──')
  lines.push('  1. Restart your terminal or run: source ~/.mipham/shell-setup.sh')
  lines.push('  2. Run: mipham --version')
  lines.push('  3. Start coding: cd your-project && mipham')
  lines.push('')
  lines.push(`Works with: Zsh, Bash. Shell: ${shell}`)

  return { content: lines.join('\n') }
}

// ═══════════════════════════════════════════════════════════════
// Phase 4 — MCP Server Management
// ═══════════════════════════════════════════════════════════════
