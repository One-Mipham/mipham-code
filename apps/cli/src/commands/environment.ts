/**
 * Mipham Code — Environment Slash Commands
 *
 * Extracted from ui/commands.ts (2026-08-06).
 * Handlers for: /theme, /release-notes, /ide, /terminal-setup
 */
import type { CommandHandler } from '../ui/commands.js'
import { NPM_INSTALL_COMMAND } from '../shared/index.ts'

export { themeCmd, releaseNotesCmd, ideCmd, terminalSetupCmd }

const themeCmd: CommandHandler = (_ctx, args) => {
  const theme = args[0]?.toLowerCase()
  const validThemes = ['dark', 'light', 'auto'] as const

  if (!theme || !validThemes.includes(theme as (typeof validThemes)[number])) {
    return {
      content: `── Theme ──

Terminal color themes (set in .mipham/config.yml):

  theme: dark    — dark background (default, recommended for terminals)
  theme: light   — light background
  theme: auto    — follow system preference

Usage: /theme dark | light | auto

Current: auto (follows terminal)`,
    }
  }

  return {
    content: `✓ Theme set to "${theme}".

Add to ~/.mipham/config.yml to persist:
  theme: ${theme}

Terminal themes affect syntax highlighting and UI accents.
Full theme customization is available in the Web UI at https://mipham.ai/code/dashboard`,
  }
}

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

v0.1.2 (2026-06-09) — Current
  • 48 slash commands (up from 20)
  • /setup guided project initialization wizard
  • Checkpoint/rewind mechanism
  • Focus mode (last exchange view)
  • 3-level MIPHAM.md architecture
  • /doctor system diagnostics
  • /export conversation to file
  • /review and /pr-comments code review workflows
  • /memory management
  • /upgrade instructions
  • Clipboard support (macOS/Windows)

v0.1.1 (2026-06-02)
  • Inline shared module for standalone builds
  • Bin path fix for npm compatibility

v0.1.0 (2026-06-01)
  • Initial release
  • Multi-model support (7 providers)
  • 16 built-in tools
  • 11 skills (9 standard + 2 mipham)
  • Ctrl+P interactive model picker
  • SSE streaming support

Full changelog: https://mipham.ai/code/releases`,
})

// ═══════════════════════════════════════════════════════════════
// IDE — IDE integration guide
// ═══════════════════════════════════════════════════════════════

const ideCmd: CommandHandler = async (_ctx) => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
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

  // ── settings.json: terminal profile ──
  const settingsPath = join(vscodeDir, 'settings.json')
  const settings = {
    'terminal.integrated.profiles.osx': {
      mipham: {
        path: bunPath,
        args: ['run', 'mipham'],
        cwd: '${workspaceFolder}',
      },
    },
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  files.push('.vscode/settings.json')

  // ── keybindings.json: Cmd+Esc launch ──
  const keybindingsPath = join(vscodeDir, 'keybindings.json')
  const keybindings = [
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
  writeFileSync(keybindingsPath, JSON.stringify(keybindings, null, 2) + '\n', 'utf-8')
  files.push('.vscode/keybindings.json')

  // ── extensions.json: recommended ──
  const extensionsPath = join(vscodeDir, 'extensions.json')
  const extensions = {
    recommendations: ['miphamai.mipham-code'],
  }
  writeFileSync(extensionsPath, JSON.stringify(extensions, null, 2) + '\n', 'utf-8')
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
  const { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync } =
    await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  const home = homedir()
  const lines: string[] = ['── Terminal Setup ──', '']

  // ── 1. Generate standalone shell setup script ──
  const miphamDir = join(home, '.mipham')
  mkdirSync(miphamDir, { recursive: true })

  const shellScript = join(miphamDir, 'shell-setup.sh')
  const shellContent = [
    '#!/bin/bash',
    '# Mipham Code — Shell Integration',
    '# Source this file in your shell profile:',
    '#   source ~/.mipham/shell-setup.sh',
    '',
    `export MIPHAM_HOME="${home}/.mipham"`,
    '',
    '# Alias: launch Mipham Code in current directory',
    `alias mipham='cd $(pwd) && ${NPM_INSTALL_COMMAND} > /dev/null 2>&1; mipham'`,
    '',
    '# Or use the local development version:',
    '# alias mipham="bun run /path/to/mipham-code/apps/cli/bin/mipham"',
    '',
    '# Auto-detect provider from config',
    'if [ -f ~/.mipham/config.yml ]; then',
    '  export MIPHAM_PROVIDER=$(grep "defaultProvider:" ~/.mipham/config.yml | awk "{print \$2}")',
    'fi',
  ].join('\n')
  writeFileSync(shellScript, shellContent + '\n', 'utf-8')
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
      appendFileSync(profilePath, sourceLine, 'utf-8')
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
