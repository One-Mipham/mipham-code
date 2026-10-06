/**
 * Mipham Code — VS Code Extension
 *
 * Provides:
 *  - Integrated terminal launch with Mipham Code
 *  - Status bar item showing active provider/model
 *  - Cmd+Esc quick launch
 *  - File context sharing with the CLI
 */

const vscode = require('vscode')

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
    notFound:
      'Mipham Code was not found on your PATH. Install it with "npm install -g @miphamai/cli", or set "mipham-code.bunPath" in settings.',
  },
  'zh-CN': {
    statusBar: 'Mipham Code',
    tooltip: '点击聚焦 Mipham Code 终端',
    welcome: 'Mipham Code 已就绪。按 Cmd+Esc 启动。',
    noConfig: '未找到 Mipham Code 配置。运行 "mipham /init" 创建。',
    start: '启动',
    dismiss: '关闭',
    terminalName: 'Mipham Code',
    notFound:
      '未在 PATH 上找到 Mipham Code。请安装：npm install -g @miphamai/cli，或在设置中配置 "mipham-code.bunPath"。',
  },
}

function t(key) {
  return MSGS[LOCALE]?.[key] || MSGS['en-US'][key] || key
}

/**
 * Is `name` an executable found on PATH?
 *
 * The extension host cannot see the terminal's shell environment, so "this
 * command will resolve" can only be decided by looking on PATH itself. Without
 * this check the extension opens a terminal running a command that does not
 * exist: the shell prints "command not found", the user has to notice it and
 * work out why, and nothing in the editor says the launch was the problem.
 */
function onPath(name) {
  const fs = require('fs')
  const path = require('path')
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK)
      return true
    } catch {
      /* not in this directory */
    }
  }
  return false
}

/** Active terminal tracking */
let miphamTerminal = null
let statusBarItem = null

/**
 * Find or detect the bun runtime path.
 */
function detectBunPath() {
  const config = vscode.workspace.getConfiguration('mipham-code')
  const configured = config.get('bunPath', '')
  if (configured) return configured

  // Common paths
  const candidates = [
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    process.env.HOME + '/.bun/bin/bun',
  ]

  const fs = require('fs')
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }

  return 'bun' // fallback — rely on PATH
}

/**
 * Find the Mipham Code entry point.
 * Priority: global npm install > local monorepo > project-relative
 */
function findMiphamPath() {
  const fs = require('fs')
  const path = require('path')

  // Check for global install
  const homeBin = path.join(process.env.HOME || '~', '.bun', 'bin', 'mipham')
  if (fs.existsSync(homeBin)) return homeBin

  // Check for local monorepo
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd()
  const localBin = path.join(workspaceRoot, 'apps', 'cli', 'bin', 'mipham')
  if (fs.existsSync(localBin)) return localBin

  // Fallback — rely on npm global
  return 'mipham'
}

/**
 * Build provider/model flags from VS Code settings.
 */
function buildFlags() {
  const config = vscode.workspace.getConfiguration('mipham-code')
  const flags = []
  const provider = config.get('provider', '')
  const model = config.get('model', '')
  if (provider) flags.push('--provider', provider)
  if (model) flags.push('--model', model)
  return flags
}

/**
 * Create or reveal a Mipham Code terminal.
 */
function openMiphamTerminal() {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd()

  // Reuse existing terminal if still alive
  if (miphamTerminal && miphamTerminal.exitStatus === undefined) {
    miphamTerminal.show()
    return miphamTerminal
  }

  const fs = require('fs')
  const bunPath = detectBunPath()
  const miphamPath = findMiphamPath()
  const flags = buildFlags()

  // Refuse to launch something that will not run. `findMiphamPath` falls back to
  // the bare string 'mipham' when nothing was found on disk, and `detectBunPath`
  // falls back to 'bun' the same way — both are bets that PATH will resolve them.
  // Make the bet explicit so a miss is an error message instead of a terminal
  // that opens, prints "command not found", and leaves the user guessing.
  const runnable =
    miphamPath === 'mipham' ? onPath('mipham') : fs.existsSync(bunPath) || onPath(bunPath)
  if (!runnable) {
    vscode.window.showErrorMessage(t('notFound'))
    return undefined
  }

  const terminalName = t('terminalName')

  // Create the terminal
  if (miphamPath === 'mipham') {
    // Global install — just run directly
    miphamTerminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: workspaceRoot,
    })
    miphamTerminal.sendText([miphamPath, ...flags].join(' '))
  } else {
    // Local path — use bun to run it
    miphamTerminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: workspaceRoot,
    })
    miphamTerminal.sendText([bunPath, miphamPath, ...flags].filter(Boolean).join(' '))
  }

  miphamTerminal.show()

  // Clean up reference on close
  const disposable = vscode.window.onDidCloseTerminal((t) => {
    if (t === miphamTerminal) {
      miphamTerminal = null
      disposable.dispose()
    }
  })

  return miphamTerminal
}

/**
 * Update status bar with current provider/model info.
 */
function updateStatusBar() {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    statusBarItem.command = 'mipham-code.focus'
    statusBarItem.tooltip = t('tooltip')
  }

  const config = vscode.workspace.getConfiguration('mipham-code')
  const provider = config.get('provider', '') || 'default'
  const model = config.get('model', '') || 'auto'
  statusBarItem.text = `$(terminal) ${t('statusBar')}`
  statusBarItem.show()
}

/**
 * Activation — called when VS Code starts.
 */
function activate(context) {
  // Register commands
  const startCmd = vscode.commands.registerCommand('mipham-code.start', () => {
    openMiphamTerminal()
  })

  const focusCmd = vscode.commands.registerCommand('mipham-code.focus', () => {
    if (miphamTerminal) {
      miphamTerminal.show()
    } else {
      openMiphamTerminal()
    }
  })

  const configCmd = vscode.commands.registerCommand('mipham-code.openConfig', () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd()
    const configPath = vscode.Uri.file(require('path').join(workspaceRoot, '.mipham', 'config.yml'))
    vscode.window.showTextDocument(configPath).then(
      () => {},
      () => {
        // Config file doesn't exist — open user config
        const userConfig = vscode.Uri.file(
          require('path').join(process.env.HOME || '~', '.mipham', 'config.yml'),
        )
        vscode.window.showTextDocument(userConfig).then(
          () => {},
          () => vscode.window.showInformationMessage(t('noConfig')),
        )
      },
    )
  })

  // Status bar
  updateStatusBar()

  // Listen for config changes
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('mipham-code')) {
      updateStatusBar()
    }
  })

  // Show welcome message on first activation
  const hasShown = context.globalState.get('miphamCode.welcomeShown', false)
  if (!hasShown) {
    vscode.window.showInformationMessage(t('welcome'), t('start'), t('dismiss')).then((choice) => {
      if (choice === t('start')) openMiphamTerminal()
    })
    context.globalState.update('miphamCode.welcomeShown', true)
  }

  context.subscriptions.push(startCmd, focusCmd, configCmd, statusBarItem)
}

/**
 * Deactivation — cleanup.
 */
function deactivate() {
  if (miphamTerminal) {
    miphamTerminal.dispose()
    miphamTerminal = null
  }
  if (statusBarItem) {
    statusBarItem.dispose()
    statusBarItem = null
  }
}

module.exports = { activate, deactivate }
