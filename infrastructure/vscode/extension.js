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

  const bunPath = detectBunPath()
  const miphamPath = findMiphamPath()
  const flags = buildFlags()

  const terminalName = 'Mipham Code'

  // Create the terminal
  if (miphamPath === 'mipham') {
    // Global install — just run directly
    miphamTerminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: workspaceRoot,
      env: { MIPHAM_IDE: 'vscode' },
    })
    miphamTerminal.sendText([miphamPath, ...flags].join(' '))
  } else {
    // Local path — use bun to run it
    miphamTerminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: workspaceRoot,
      env: { MIPHAM_IDE: 'vscode' },
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
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    )
    statusBarItem.command = 'mipham-code.focus'
    statusBarItem.tooltip = 'Click to focus Mipham Code terminal'
  }

  const config = vscode.workspace.getConfiguration('mipham-code')
  const provider = config.get('provider', '') || 'default'
  const model = config.get('model', '') || 'auto'
  statusBarItem.text = `$(terminal) Mipham Code`
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
    const configPath = vscode.Uri.file(
      require('path').join(workspaceRoot, '.mipham', 'config.yml'),
    )
    vscode.window.showTextDocument(configPath).then(
      () => {},
      () => {
        // Config file doesn't exist — open user config
        const userConfig = vscode.Uri.file(
          require('path').join(process.env.HOME || '~', '.mipham', 'config.yml'),
        )
        vscode.window.showTextDocument(userConfig).then(
          () => {},
          () => vscode.window.showInformationMessage(
            'No Mipham Code config found. Run "mipham /init" to create one.',
          ),
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
    vscode.window.showInformationMessage(
      'Mipham Code is ready. Press Cmd+Esc to start.',
      'Start',
      'Dismiss',
    ).then((choice) => {
      if (choice === 'Start') openMiphamTerminal()
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
