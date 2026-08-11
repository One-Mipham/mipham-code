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

  // Check latest version from npm with retry + mirror fallback.
  // Track which registry responded so we can use it for the install step too.
  let latestVersion = ''
  let workingRegistry = 'https://registry.npmjs.org/' // default
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
        if (latestVersion) {
          workingRegistry = attempt.registry
          break
        }
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

  const ok = performUpdate(latestVersion, workingRegistry)
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

// ── Daemon lifecycle commands ──────────────────────────────────────────────────

async function runDaemonCLI(): Promise<boolean> {
  const args = process.argv.slice(2)
  if (args[0] !== 'daemon') return false

  const subcmd = args[1]

  const { spawn } = await import('node:child_process')

  if (subcmd === 'start') {
    const { getDaemonStatus } = await import('../src/daemon/index')
    const status = getDaemonStatus()
    if (status) {
      console.log(`Daemon already running (PID: ${status.pid}, Port: ${status.port})`)
      process.exit(0)
    }

    console.log('Starting daemon...')
    const daemonScript = new URL('./daemon.ts', import.meta.url).pathname
    const child = spawn('bun', ['run', daemonScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()

    // Wait briefly for daemon to write PID/port files
    await new Promise((resolve) => setTimeout(resolve, 1000))

    const newStatus = getDaemonStatus()
    if (newStatus) {
      console.log(`Daemon started (PID: ${newStatus.pid}, Port: ${newStatus.port})`)
    } else {
      console.log('Daemon started (PID unknown — check `mipham daemon status`)')
    }
    process.exit(0)
  }

  if (subcmd === 'stop') {
    const { getDaemonStatus } = await import('../src/daemon/index')
    const status = getDaemonStatus()
    if (!status) {
      console.log('Daemon is not running.')
      process.exit(0)
    }
    try {
      process.kill(status.pid, 'SIGTERM')
      console.log(`Daemon stopped (PID: ${status.pid})`)
    } catch {
      console.log('Daemon is not running.')
    }
    process.exit(0)
  }

  if (subcmd === 'status') {
    const { getDaemonStatus } = await import('../src/daemon/index')
    const status = getDaemonStatus()
    if (status) {
      console.log(`Daemon: running`)
      console.log(`  PID:    ${status.pid}`)
      console.log(`  Port:   ${status.port}`)
      console.log(`  URL:    http://127.0.0.1:${status.port}`)
    } else {
      console.log(`Daemon: not running`)
    }
    process.exit(0)
  }

  if (subcmd === 'restart') {
    const { getDaemonStatus } = await import('../src/daemon/index')
    const status = getDaemonStatus()
    if (status) {
      try {
        process.kill(status.pid, 'SIGTERM')
      } catch {
        // Process may have already exited
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    const daemonScript = new URL('./daemon.ts', import.meta.url).pathname
    const child = spawn('bun', ['run', daemonScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    console.log('Daemon restarted.')
    process.exit(0)
  }

  // Unknown subcommand
  console.error(`Unknown daemon command: mipham daemon ${subcmd}`)
  console.error('Usage: mipham daemon start|stop|status|restart')
  process.exit(1)
}

// ── Attach: connect TUI to a daemon session ────────────────────────────────

async function runAttachCLI(): Promise<boolean> {
  const args = process.argv.slice(2)
  if (args[0] !== 'attach') return false

  const { getPort, getDaemonStatus } = await import('../src/daemon/index')
  const { join } = await import('node:path')
  const { readFileSync, existsSync } = await import('node:fs')
  const { homedir } = await import('node:os')

  // Check if daemon is running
  const status = getDaemonStatus()
  if (!status) {
    console.error('No daemon running. Start one with: mipham daemon start')
    process.exit(1)
  }

  const port = getPort()
  const tokenPath = join(homedir(), '.mipham', 'daemon.token')
  let token = ''
  if (existsSync(tokenPath)) {
    token = readFileSync(tokenPath, 'utf-8').trim()
  }

  // Fetch active sessions from daemon
  interface SessionInfo {
    id: string
    name: string
    cwd: string
    status: string
    model: string
    updatedAt: string
  }

  let sessions: SessionInfo[] = []
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`)
    const data = (await resp.json()) as { ok: boolean; data?: { sessions: SessionInfo[] } }
    if (data.ok && data.data) {
      sessions = data.data.sessions.filter((s) => s.status === 'active' || s.status === 'idle')
    }
  } catch (err) {
    console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
    process.exit(1)
  }

  const latestFlag = args.includes('--latest')
  const sessionIdArg = args[1] && !args[1].startsWith('-') ? args[1] : undefined

  let targetSession: SessionInfo | null = null

  if (latestFlag) {
    if (sessions.length === 0) {
      console.error('No active sessions found.')
      process.exit(1)
    }
    targetSession = sessions[0]! // Most recently updated active/idle session
  } else if (sessionIdArg) {
    targetSession =
      sessions.find((s) => s.id === sessionIdArg || s.id.startsWith(sessionIdArg)) ?? null
    if (!targetSession) {
      console.error(`Session "${sessionIdArg}" not found.`)
      if (sessions.length > 0) {
        console.error(`Available sessions:`)
        for (const s of sessions) {
          console.error(`  ${s.id.slice(0, 8)}  ${s.name}  [${s.status}]  ${s.cwd}`)
        }
      }
      process.exit(1)
    }
  } else {
    // List sessions and show usage
    if (sessions.length === 0) {
      console.log('No active sessions.')
    } else {
      console.log('Active sessions:')
      for (const s of sessions) {
        const shortId = s.id.slice(0, 8)
        console.log(`  ${shortId}  ${s.name}  [${s.status}]  ${s.model}  ${s.cwd}`)
      }
    }
    console.log()
    console.log('Usage:')
    console.log('  mipham attach <id>       Attach to a specific session')
    console.log('  mipham attach --latest   Attach to the most recent session')
    process.exit(0)
  }

  // Read version for the TUI header
  let version = '0.0.0'
  try {
    const pkgPath = join(import.meta.dirname!, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    version = pkg.version
  } catch {
    // fallback
  }

  // Launch TUI in remote mode — the engine will connect via WebSocket
  const { runApp } = await import('../src/index')
  await runApp({
    version,
    remoteSession: {
      sessionId: targetSession.id,
      port,
      token,
    },
  })
  return true
}

// ── Agent CLI: inspect and manage daemon agents ─────────────────────────────

async function runAgentCLI(): Promise<boolean> {
  const args = process.argv.slice(2)
  if (args[0] !== 'agents' && args[0] !== 'agent') return false

  const { getPort, getDaemonStatus } = await import('../src/daemon/index')
  const { join } = await import('node:path')
  const { readFileSync, existsSync } = await import('node:fs')
  const { homedir } = await import('node:os')

  // Check if daemon is running
  const status = getDaemonStatus()
  if (!status) {
    console.error('No daemon running. Start one with: mipham daemon start')
    process.exit(1)
  }

  const port = getPort()
  const tokenPath = join(homedir(), '.mipham', 'daemon.token')
  let token = ''
  if (existsSync(tokenPath)) {
    token = readFileSync(tokenPath, 'utf-8').trim()
  }

  const baseUrl = `http://127.0.0.1:${port}`

  // ── mipham agents ──────────────────────────────────────────
  if (args[0] === 'agents') {
    try {
      const resp = await fetch(`${baseUrl}/api/v1/agents`)
      const data = (await resp.json()) as {
        ok: boolean
        data?: {
          agents: Array<{
            id: string
            status: string
            agentType: string
            description: string
            createdAt: string
            sessionId: string
          }>
        }
      }
      if (!data.ok || !data.data) {
        console.error('Failed to fetch agents.')
        process.exit(1)
      }
      const agents = data.data.agents
      if (agents.length === 0) {
        console.log('No agents found.')
      } else {
        for (const a of agents) {
          const shortId = a.id.slice(0, 12)
          console.log(`${shortId}  [${a.status}]  ${a.agentType}  ${a.description}`)
        }
      }
    } catch (err) {
      console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // ── mipham agent <id|subcommand> ───────────────────────────
  const target = args[1]
  if (!target) {
    console.error('Usage: mipham agent <id|message|stop> [...]')
    process.exit(1)
  }

  // mipham agent message <id> [--content <text>]
  if (target === 'message') {
    const agentId = args[2]
    if (!agentId) {
      console.error('Usage: mipham agent message <id> [--content <text>]')
      process.exit(1)
    }

    let content = ''
    const contentFlagIdx = args.indexOf('--content')
    if (contentFlagIdx !== -1 && args[contentFlagIdx + 1]) {
      content = args[contentFlagIdx + 1]!
    } else {
      // Prompt for content interactively
      const { createInterface } = await import('node:readline')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      content = await new Promise<string>((resolve) => {
        rl.question('Message: ', (answer) => {
          rl.close()
          resolve(answer)
        })
      })
    }

    if (!content.trim()) {
      console.error('Message content is required.')
      process.exit(1)
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v1/agents/${agentId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      const data = (await resp.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        console.error(`Error: ${data.error || 'Unknown error'}`)
        process.exit(1)
      }
      console.log(`Message sent to agent ${agentId}`)
    } catch (err) {
      console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // mipham agent stop <id>
  if (target === 'stop') {
    const agentId = args[2]
    if (!agentId) {
      console.error('Usage: mipham agent stop <id>')
      process.exit(1)
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v1/agents/${agentId}`, { method: 'DELETE' })
      const data = (await resp.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        console.error(`Error: ${data.error || 'Unknown error'}`)
        process.exit(1)
      }
      console.log(`Agent ${agentId} stopped.`)
    } catch (err) {
      console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // mipham agent <id> — show detail
  const agentId = target
  try {
    const resp = await fetch(`${baseUrl}/api/v1/agents/${agentId}`)
    const data = (await resp.json()) as {
      ok: boolean
      data?: {
        agent: {
          id: string
          agentType: string
          description: string
          status: string
          kind: string
          sessionId: string
          createdAt: string
          completedAt?: string | null
          result?: string | null
          error?: string | null
          worktree?: string | null
          branch?: string | null
          prUrl?: string | null
          parentId?: string | null
        }
      }
      error?: string
    }
    if (!data.ok || !data.data) {
      console.error(`Error: ${data.error || 'Agent not found'}`)
      process.exit(1)
    }
    const a = data.data.agent
    console.log(`Agent: ${a.id}`)
    console.log(`  Type:        ${a.agentType}`)
    console.log(`  Description: ${a.description}`)
    console.log(`  Status:      ${a.status}`)
    console.log(`  Kind:        ${a.kind}`)
    console.log(`  Session:     ${a.sessionId}`)
    if (a.parentId) console.log(`  Parent:      ${a.parentId}`)
    console.log(`  Created:     ${a.createdAt}`)
    if (a.completedAt) console.log(`  Completed:   ${a.completedAt}`)
    if (a.result) console.log(`  Result:      ${a.result}`)
    if (a.error) console.log(`  Error:       ${a.error}`)
    if (a.worktree) console.log(`  Worktree:    ${a.worktree}`)
    if (a.branch) console.log(`  Branch:      ${a.branch}`)
    if (a.prUrl) console.log(`  PR:          ${a.prUrl}`)
  } catch (err) {
    console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
    process.exit(1)
  }
  process.exit(0)
}

// ── Goal CLI: manage daemon goals ─────────────────────────────────────────────

async function runGoalCLI(): Promise<boolean> {
  const args = process.argv.slice(2)
  if (args[0] !== 'goal') return false

  const { getPort, getDaemonStatus } = await import('../src/daemon/index')

  // Check if daemon is running
  const status = getDaemonStatus()
  if (!status) {
    console.error('No daemon running. Start one with: mipham daemon start')
    process.exit(1)
  }

  const port = getPort()
  const baseUrl = `http://127.0.0.1:${port}`

  const subcmd = args[1]
  if (!subcmd) {
    console.error('Usage: mipham goal list|add|done|pause [options]')
    process.exit(1)
  }

  // ── mipham goal list [--session <id>] ─────────────────────────
  if (subcmd === 'list') {
    const sessionIdx = args.indexOf('--session')
    const sessionId = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined
    if (!sessionId) {
      console.error('Usage: mipham goal list --session <id>')
      process.exit(1)
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v1/goals?session=${sessionId}`)
      const data = (await resp.json()) as {
        ok: boolean
        data?: {
          goals: Array<{
            id: number
            description: string
            status: string
            progress: { current: number; total: number } | null
            createdAt: string
          }>
        }
      }
      if (!data.ok || !data.data) {
        console.error('Failed to fetch goals.')
        process.exit(1)
      }
      const goals = data.data.goals
      if (goals.length === 0) {
        console.log('No goals found.')
      } else {
        for (const g of goals) {
          const progressStr = g.progress ? ` [${g.progress.current}/${g.progress.total}]` : ''
          console.log(`#${g.id}  [${g.status}]${progressStr}  ${g.description}`)
        }
      }
    } catch (err) {
      console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // ── mipham goal add --session <id> --desc <text> [--current <n> --total <n>] ─
  if (subcmd === 'add') {
    const sessionIdx = args.indexOf('--session')
    const sessionId = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined
    const descIdx = args.indexOf('--desc')
    const description = descIdx !== -1 ? args[descIdx + 1] : undefined

    if (!sessionId || !description) {
      console.error(
        'Usage: mipham goal add --session <id> --desc <text> [--current <n> --total <n>]',
      )
      process.exit(1)
    }

    const currentIdx = args.indexOf('--current')
    const totalIdx = args.indexOf('--total')
    const current = currentIdx !== -1 ? parseInt(args[currentIdx + 1]!, 10) : undefined
    const total = totalIdx !== -1 ? parseInt(args[totalIdx + 1]!, 10) : undefined
    const progress = current !== undefined && total !== undefined ? { current, total } : undefined

    try {
      const resp = await fetch(`${baseUrl}/api/v1/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, description, progress }),
      })
      const data = (await resp.json()) as { ok: boolean; data?: { id: number }; error?: string }
      if (!data.ok) {
        console.error(`Error: ${data.error || 'Unknown error'}`)
        process.exit(1)
      }
      console.log(`Goal #${data.data!.id} created.`)
    } catch (err) {
      console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // ── mipham goal done <id> ──────────────────────────────────────
  if (subcmd === 'done') {
    const goalId = args[2]
    if (!goalId) {
      console.error('Usage: mipham goal done <id>')
      process.exit(1)
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v1/goals/${goalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      })
      const data = (await resp.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        console.error(`Error: ${data.error || 'Unknown error'}`)
        process.exit(1)
      }
      console.log(`Goal #${goalId} marked as done.`)
    } catch (err) {
      console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // ── mipham goal pause <id> ─────────────────────────────────────
  if (subcmd === 'pause') {
    const goalId = args[2]
    if (!goalId) {
      console.error('Usage: mipham goal pause <id>')
      process.exit(1)
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v1/goals/${goalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'paused' }),
      })
      const data = (await resp.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        console.error(`Error: ${data.error || 'Unknown error'}`)
        process.exit(1)
      }
      console.log(`Goal #${goalId} paused.`)
    } catch (err) {
      console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
      process.exit(1)
    }
    process.exit(0)
  }

  console.error(`Unknown goal command: mipham goal ${subcmd}`)
  console.error('Usage: mipham goal list|add|done|pause [options]')
  process.exit(1)
}

// ── Schedule CLI: manage daemon schedules ─────────────────────────────────────

async function runScheduleCLI(): Promise<boolean> {
  const args = process.argv.slice(2)
  if (args[0] !== 'schedule') return false

  const { getPort, getDaemonStatus } = await import('../src/daemon/index')

  // Check if daemon is running
  const status = getDaemonStatus()
  if (!status) {
    console.error('No daemon running. Start one with: mipham daemon start')
    process.exit(1)
  }

  const port = getPort()
  const baseUrl = `http://127.0.0.1:${port}`

  const subcmd = args[1]
  if (!subcmd) {
    console.error('Usage: mipham schedule list|add|remove [options]')
    process.exit(1)
  }

  // ── mipham schedule list [--session <id>] ──────────────────────
  if (subcmd === 'list') {
    const sessionIdx = args.indexOf('--session')
    const sessionId = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined
    if (!sessionId) {
      console.error('Usage: mipham schedule list --session <id>')
      process.exit(1)
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v1/schedules?session=${sessionId}`)
      const data = (await resp.json()) as {
        ok: boolean
        data?: {
          schedules: Array<{
            id: number
            cronExpr: string
            prompt: string
            enabled: boolean
            lastFired: string | null
            nextFire: string
          }>
        }
      }
      if (!data.ok || !data.data) {
        console.error('Failed to fetch schedules.')
        process.exit(1)
      }
      const schedules = data.data.schedules
      if (schedules.length === 0) {
        console.log('No schedules found.')
      } else {
        for (const s of schedules) {
          const enabledStr = s.enabled ? 'enabled' : 'disabled'
          const lastStr = s.lastFired ? ` last: ${s.lastFired}` : ''
          console.log(`#${s.id}  [${enabledStr}]  ${s.cronExpr}  next: ${s.nextFire}${lastStr}`)
          console.log(`       prompt: ${s.prompt}`)
        }
      }
    } catch (err) {
      console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // ── mipham schedule add --session <id> --cron <expr> --prompt <text> ──
  if (subcmd === 'add') {
    const sessionIdx = args.indexOf('--session')
    const sessionId = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined
    const cronIdx = args.indexOf('--cron')
    const cronExpr = cronIdx !== -1 ? args[cronIdx + 1] : undefined
    const promptIdx = args.indexOf('--prompt')
    const prompt = promptIdx !== -1 ? args[promptIdx + 1] : undefined

    if (!sessionId || !cronExpr || !prompt) {
      console.error('Usage: mipham schedule add --session <id> --cron <expr> --prompt <text>')
      process.exit(1)
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v1/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, cronExpr, prompt }),
      })
      const data = (await resp.json()) as { ok: boolean; data?: { id: number }; error?: string }
      if (!data.ok) {
        console.error(`Error: ${data.error || 'Unknown error'}`)
        process.exit(1)
      }
      console.log(`Schedule #${data.data!.id} created (cron: ${cronExpr}).`)
    } catch (err) {
      console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
      process.exit(1)
    }
    process.exit(0)
  }

  // ── mipham schedule remove <id> ─────────────────────────────────
  if (subcmd === 'remove') {
    const scheduleId = args[2]
    if (!scheduleId) {
      console.error('Usage: mipham schedule remove <id>')
      process.exit(1)
    }

    try {
      const resp = await fetch(`${baseUrl}/api/v1/schedules/${scheduleId}`, { method: 'DELETE' })
      const data = (await resp.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        console.error(`Error: ${data.error || 'Unknown error'}`)
        process.exit(1)
      }
      console.log(`Schedule #${scheduleId} removed.`)
    } catch (err) {
      console.error(`Failed to connect to daemon at port ${port}: ${String(err)}`)
      process.exit(1)
    }
    process.exit(0)
  }

  console.error(`Unknown schedule command: mipham schedule ${subcmd}`)
  console.error('Usage: mipham schedule list|add|remove [options]')
  process.exit(1)
}

async function main() {
  // ── Disable terminal special characters ──────────────────────────────────
  // Terminal intercepts Ctrl+S (XOFF), Ctrl+T (SIGINFO/status), Ctrl+R (rprnt)
  // before the app sees them. Disable these so Agent Dashboard shortcuts work.
  // IMPORTANT: stty needs the real terminal on stdin — 'ignore' won't work.
  const { execSync } = await import('node:child_process')
  let savedStty = ''
  try {
    savedStty = execSync('stty -g', {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'ignore'],
    }).trim()
    execSync('stty -ixon stop undef start undef status undef rprnt undef', {
      stdio: ['inherit', 'ignore', 'ignore'],
    })
  } catch {
    // Non-POSIX platform (Windows) — no special chars to disable
  }
  // Restore original terminal settings on exit
  const restoreTerminal = () => {
    if (!savedStty) return
    try {
      execSync(`stty ${savedStty}`, {
        stdio: ['inherit', 'ignore', 'ignore'],
      })
    } catch {
      /* ignore */
    }
  }
  process.on('exit', restoreTerminal)
  process.on('SIGINT', restoreTerminal)
  process.on('SIGTERM', restoreTerminal)

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
  mipham daemon <cmd>        Daemon lifecycle (start, stop, status, restart)
  mipham attach [id]         Attach to a daemon session (--latest for recent)
  mipham agents              List all agents
  mipham agent <id>          Show agent detail
  mipham agent message <id>  Send message to an agent
  mipham agent stop <id>     Stop a running agent
  mipham goal <cmd>          Goal management (list, add, done, pause)
  mipham schedule <cmd>      Schedule management (list, add, remove)
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

  // ── Daemon commands ───────────────────────────────────────────────────────
  const handledDaemon = await runDaemonCLI()
  if (handledDaemon) return

  // ── Attach commands ───────────────────────────────────────────────────────
  const handledAttach = await runAttachCLI()
  if (handledAttach) return

  // ── Agent commands ────────────────────────────────────────────────────────
  const handledAgent = await runAgentCLI()
  if (handledAgent) return

  // ── Goal commands ──────────────────────────────────────────────────────────
  const handledGoal = await runGoalCLI()
  if (handledGoal) return

  // ── Schedule commands ──────────────────────────────────────────────────────
  const handledSchedule = await runScheduleCLI()
  if (handledSchedule) return

  // Check for plugin subcommands first
  const handledPlugin = await runPluginCLI()
  if (handledPlugin) return

  // Check for workflow subcommands next
  const handled = await runWorkflowCLI()
  if (handled) return

  // ── Unknown command detection ──────────────────────────────────────────────
  // After all known subcommands are checked, any remaining positional argument
  // is probably a typo. Show error + suggestions instead of silently launching CLI.
  const KNOWN_COMMANDS = [
    'update',
    'upgrade',
    'plugin',
    'workflow',
    'daemon',
    'attach',
    'agents',
    'agent',
    'goal',
    'schedule',
    'help',
  ]
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
