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

  program
    .name('mipham workflow')
    .description('Workflow orchestration commands')

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
        console.log(
          `Resuming workflow ${runId} with ${entries.length} journal entries...`,
        )
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

async function main() {
  // Check for workflow subcommands first
  const handled = await runWorkflowCLI()
  if (handled) return

  try {
    const { runApp } = await import('../src/index')
    await runApp({})
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
