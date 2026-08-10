#!/usr/bin/env bun
/**
 * Mipham Code — Bun-native entry point for compiled binary.
 * Used by `bun build --compile` to produce standalone executables.
 */

export {} // ensure module scope (prevents global name collisions)

async function runWorkflowCLI(): Promise<boolean> {
  const args = process.argv.slice(2)
  if (args[0] !== 'workflow') return false

  const { Command } = await import('commander')
  const program = new Command()

  program.name('mipham workflow').description('Workflow orchestration commands')

  program
    .command('run <script>')
    .description('Run a workflow script')
    .option('--args <json>', 'JSON arguments for the workflow')
    .action(async (scriptPath: string, opts: { args?: string }) => {
      const { readFileSync } = await import('node:fs')
      const { runWorkflow } = await import('../src/workflow/runtime')
      const { loadConfig } = await import('../src/config/loader')
      const { bootstrapProviders } = await import('../src/providers/bootstrap')
      const { ContextManager } = await import('../src/core/context')
      const { QueryEngine } = await import('../src/core/engine')
      const { createToolRegistry } = await import('../src/tools')

      const script = readFileSync(scriptPath, 'utf-8')
      const workflowArgs = opts.args ? JSON.parse(opts.args) : {}

      // Bootstrap minimal engine
      const config = loadConfig()
      const registry = bootstrapProviders(
        config.providers,
        config.defaultProvider,
        config.defaultModel,
      )
      const context = new ContextManager({ maxTokens: 200_000, compactionThreshold: 0.9 })
      const tools = createToolRegistry()
      const engine = new QueryEngine(registry, context, tools)
      engine.setupContextSummarizer()

      const result = await runWorkflow(script, engine, workflowArgs)
      console.log(JSON.stringify(result, null, 2))
      process.exit(0)
    })

  program
    .command('list')
    .description('List all workflow runs')
    .action(async () => {
      const { listRuns } = await import('../src/workflow/journal')
      const runs = listRuns()
      if (runs.length === 0) {
        console.log('No workflow runs found.')
      } else {
        runs.forEach((r) => console.log(r))
      }
      process.exit(0)
    })

  program
    .command('resume <runId>')
    .description('Resume a paused workflow')
    .action(async (runId: string) => {
      const { loadJournal } = await import('../src/workflow/journal')
      const entries = loadJournal(runId)
      if (entries.length === 0) {
        console.log(`No journal found for run: ${runId}`)
      } else {
        console.log(`Resuming workflow ${runId} with ${entries.length} journal entries...`)
        // Replay completed agents, continue from last state
      }
      process.exit(0)
    })

  program
    .command('stop <runId>')
    .description('Stop a running workflow')
    .action(async (runId: string) => {
      console.log(`Stopping workflow ${runId}...`)
      // Mark workflow as stopped in state
      process.exit(0)
    })

  // Commander will handle --help, unknown commands, etc.
  await program.parseAsync(process.argv)
  return true
}

async function runPluginCLI(): Promise<boolean> {
  const args = process.argv.slice(2)
  if (args[0] !== 'plugin') return false

  const { Command } = await import('commander')
  const program = new Command()

  program.name('mipham plugin').description('Plugin management commands')

  program
    .command('install <path>')
    .description('Install a plugin from a directory path')
    .action(async (sourcePath: string) => {
      const { PluginManager } = await import('../src/plugin/plugin-manager')
      const manager = new PluginManager()
      const result = manager.install(sourcePath)
      console.log(result.message)
      process.exit(result.success ? 0 : 1)
    })

  program
    .command('list')
    .description('List installed plugins')
    .action(async () => {
      const { PluginManager } = await import('../src/plugin/plugin-manager')
      const manager = new PluginManager()
      const plugins = manager.list()
      if (plugins.length === 0) {
        console.log('No plugins installed.')
      } else {
        for (const p of plugins) {
          const status = p.enabled ? 'enabled' : 'disabled'
          console.log(`${p.name} v${p.version} [${status}] — ${p.installedAt}`)
        }
      }
      process.exit(0)
    })

  program
    .command('remove <name>')
    .description('Remove an installed plugin')
    .action(async (name: string) => {
      const { PluginManager } = await import('../src/plugin/plugin-manager')
      const manager = new PluginManager()
      const removed = manager.remove(name)
      if (removed) {
        console.log(`Plugin "${name}" removed.`)
      } else {
        console.log(`Plugin "${name}" not found.`)
      }
      process.exit(removed ? 0 : 1)
    })

  program
    .command('enable <name>')
    .description('Enable a disabled plugin')
    .action(async (name: string) => {
      const { PluginManager } = await import('../src/plugin/plugin-manager')
      const manager = new PluginManager()
      const enabled = manager.enable(name)
      if (enabled) {
        console.log(`Plugin "${name}" enabled.`)
      } else {
        console.log(`Plugin "${name}" not found.`)
      }
      process.exit(enabled ? 0 : 1)
    })

  program
    .command('disable <name>')
    .description('Disable an enabled plugin')
    .action(async (name: string) => {
      const { PluginManager } = await import('../src/plugin/plugin-manager')
      const manager = new PluginManager()
      const disabled = manager.disable(name)
      if (disabled) {
        console.log(`Plugin "${name}" disabled.`)
      } else {
        console.log(`Plugin "${name}" not found.`)
      }
      process.exit(disabled ? 0 : 1)
    })

  program
    .command('install-npm <package>')
    .description('Install a plugin from the npm registry')
    .action(async (packageName: string) => {
      const { PluginManager } = await import('../src/plugin/plugin-manager')
      const manager = new PluginManager()
      const result = manager.installFromNpm(packageName)
      console.log(result.message)
      process.exit(result.success ? 0 : 1)
    })

  await program.parseAsync(process.argv)
  return true
}

// ── Update self ────────────────────────────────────────────────────────────────

async function runUpdate(): Promise<boolean> {
  const args = process.argv.slice(2)
  if (args[0] !== 'update' && args[0] !== 'upgrade') return false

  const { getCurrentVersion, backupConfig, performUpdate, restoreConfig, getConfigPath } =
    await import('../src/shared/update')

  const { existsSync } = await import('node:fs')

  const PACKAGE = '@miphamai/cli'

  const currentVersion = getCurrentVersion()
  console.log(`Mipham Code update`)
  console.log(`  Current: v${currentVersion}`)
  console.log(`  Checking npm registry for latest version...`)
  console.log()

  // Check latest version from npm with retry + mirror fallback
  let latestVersion = ''
  try {
    const { execSync } = await import('node:child_process')

    // Registry fallback chain: npm default → npmmirror (China mirror)
    const attempts: Array<{ label: string; registry: string; timeout: number }> = [
      { label: 'npm registry', registry: 'https://registry.npmjs.org/', timeout: 10_000 },
      { label: 'npm registry (retry)', registry: 'https://registry.npmjs.org/', timeout: 20_000 },
      {
        label: 'npmmirror (China mirror)',
        registry: 'https://registry.npmmirror.com/',
        timeout: 15_000,
      },
    ]

    let lastError: Error | null = null

    for (const attempt of attempts) {
      try {
        const result = execSync(
          `npm view ${PACKAGE} version --json --registry=${attempt.registry}`,
          { encoding: 'utf-8', timeout: attempt.timeout, stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim()
        latestVersion = result.replace(/"/g, '')
        if (latestVersion) break
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        // Continue to next attempt
      }
    }

    if (!latestVersion && lastError) throw lastError
  } catch {
    console.log(`✗ Could not reach npm registry (network timeout)`)
    console.log()
    console.log(`  Manual update:`)
    console.log(`    npm install -g ${PACKAGE}@latest`)
    console.log()
    console.log(`  Or check: https://www.npmjs.com/package/${PACKAGE}`)
    process.exit(1)
  }

  if (!latestVersion) {
    console.log('✗ Could not determine latest version.')
    console.log(`  Check manually: https://www.npmjs.com/package/${PACKAGE}`)
    process.exit(1)
  }

  console.log(`  Latest:  v${latestVersion}`)
  console.log()

  // Compare versions
  if (currentVersion === latestVersion) {
    console.log(`✓ Already up to date (v${currentVersion})`)
    process.exit(0)
  }

  console.log(`→ New version available: v${currentVersion} → v${latestVersion}`)
  console.log()

  // Backup config before updating
  const backupPath = backupConfig(`update-v${currentVersion}`)
  if (backupPath) {
    console.log(`✓ Config backed up to: ${backupPath}`)
  }

  console.log()
  console.log(`Updating ${PACKAGE} to v${latestVersion}...`)

  const ok = performUpdate(latestVersion)
  if (!ok) {
    console.log()
    console.log(`✗ Update failed.`)
    if (backupPath && existsSync(backupPath)) {
      console.log(`  Your config backup is at: ${backupPath}`)
    }
    process.exit(1)
  }

  // Verify config survived
  const configPath = getConfigPath()
  if (existsSync(configPath)) {
    console.log()
    console.log(`✓ Config preserved: ${configPath}`)
  } else if (backupPath && existsSync(backupPath)) {
    console.log()
    console.log('⚠ Config was removed during update. Restoring from backup...')
    if (restoreConfig(backupPath)) {
      console.log(`✓ Config restored.`)
    }
  }

  console.log()
  console.log(`✓ Updated to ${PACKAGE} v${latestVersion}`)
  console.log(`  Run 'mipham --version' to verify.`)
  process.exit(0)
}

async function main() {
  // ── Disable terminal software flow control (XON/XOFF) ──────────────────
  // Ctrl+S and Ctrl+Q are intercepted by the terminal for flow control by default.
  // Disabling it lets our app receive these key combinations (e.g. Agent Dashboard).
  const { execSync } = await import('node:child_process')
  try {
    execSync('stty -ixon 2>/dev/null || true', { stdio: 'ignore' })
  } catch {
    // Non-POSIX platform (Windows) — no flow control to disable
  }
  // Restore flow control on exit
  const restoreFlowControl = () => {
    try {
      execSync('stty ixon 2>/dev/null || true', { stdio: 'ignore' })
    } catch { /* ignore */ }
  }
  process.on('exit', restoreFlowControl)
  process.on('SIGINT', restoreFlowControl)
  process.on('SIGTERM', restoreFlowControl)

  // ── Read version fresh from package.json at startup (bypasses Bun module cache) ──
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  let APP_VERSION = '0.0.0'
  try {
    const pkgPath = join(import.meta.dirname!, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    APP_VERSION = pkg.version
  } catch {
    // fallback — version will be '0.0.0'
  }

  // ── Version flag ──────────────────────────────────────────────────────────
  if (
    process.argv.includes('--version') ||
    process.argv.includes('-v') ||
    process.argv.includes('-V')
  ) {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname!, '..', 'package.json'), 'utf-8'))
    console.log(`${pkg.name} v${pkg.version}`)
    process.exit(0)
  }

  // ── Help flag ─────────────────────────────────────────────────────────────
  if (
    process.argv.includes('--help') ||
    process.argv.includes('-h') ||
    process.argv.slice(2).some((a) => a === 'help')
  ) {
    console.log(`Mipham Code — AI-powered coding terminal

Usage:
  mipham                     Launch interactive CLI
  mipham update              Update to the latest version
  mipham upgrade             Same as 'mipham update'
  mipham plugin <cmd>        Plugin management (install, list, remove, etc.)
  mipham workflow <cmd>      Workflow orchestration (run, list, resume, etc.)
  mipham --version           Print version and exit
  mipham --help              Show this help

Flags:
  --safe-mode                Skip custom agents, skills, hooks, plugins
  --version, -v, -V          Print version

Docs: https://mipham.ai/code
npm:  https://www.npmjs.com/package/@miphamai/cli`)
    process.exit(0)
  }

  // ── Update / upgrade ──────────────────────────────────────────────────────
  const handledUpdate = await runUpdate()
  if (handledUpdate) return

  // Check for plugin subcommands first
  const handledPlugin = await runPluginCLI()
  if (handledPlugin) return

  // Check for workflow subcommands next
  const handled = await runWorkflowCLI()
  if (handled) return

  // ── Unknown command detection ──────────────────────────────────────────────
  // After all known subcommands are checked, any remaining positional argument
  // is probably a typo. Show error + suggestions instead of silently launching CLI.
  const KNOWN_COMMANDS = ['update', 'upgrade', 'plugin', 'workflow', 'help']
  const firstArg = process.argv.slice(2).find((a) => !a.startsWith('-'))
  if (firstArg) {
    // Levenshtein distance to find closest match
    const distance = (a: string, b: string): number => {
      const m = a.length
      const n = b.length
      const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
      for (let i = 0; i <= m; i++) dp[i]![0] = i
      for (let j = 0; j <= n; j++) dp[0]![j] = j
      for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
          dp[i]![j] =
            a[i - 1] === b[j - 1]
              ? dp[i - 1]![j - 1]!
              : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
      return dp[m]![n]!
    }

    const best = KNOWN_COMMANDS.map((cmd) => ({ cmd, dist: distance(firstArg, cmd) }))
      .filter((c) => c.dist <= 3)
      .sort((a, b) => a.dist - b.dist)
    const suggestions = best.map((c) => `'mipham ${c.cmd}'`).join(', ')

    console.error(`Unknown command: mipham ${firstArg}`)
    if (suggestions) {
      console.error(`Did you mean: ${suggestions}?`)
    }
    console.error(`Run 'mipham --help' for usage.`)
    process.exit(1)
  }

  // Parse --safe-mode flag: skip custom agents, skills, hooks, plugins
  const safeModeFlag = process.argv.includes('--safe-mode')
  if (safeModeFlag) {
    process.env.MIPHAM_SAFE_MODE = '1'
  }

  try {
    const { runApp } = await import('../src/index')
    await runApp({ version: APP_VERSION })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('react-devtools-core')) {
      process.stderr.write(`
\`mipham\` compiled binary is missing a required dependency.

Reinstall Mipham Code:
  npm install -g @miphamai/cli
  mipham

Or use the shell script installer:
  curl -fsSL https://onemipham.com/install.sh | bash

Docs: https://onemipham.com/mipham-code
`)
      process.exit(1)
    }
    throw err
  }
}

main()
