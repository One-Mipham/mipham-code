/**
 * Reachability guard for multi-word slash commands.
 *
 * `parseSlashCommand` keeps only `parts[0]`, so `/crsi rules` reaches
 * `getCommand('/crsi')` — not `getCommand('/crsi rules')`. Commands registered
 * with a space are only reachable when their parent either routes to them or
 * reads `args[0]` itself. This suite fails when a registered multi-word command
 * has no such parent, which is how 25 commands silently became no-ops.
 */

import { describe, it, expect } from 'vitest'

const commandsModule = await import('../../src/ui/commands')

const {
  getCommand,
  getCommandNames,
  parseSlashCommand,
  isSubcommandRouter,
  unknownCommandMessage,
  SELF_ROUTING_PARENTS,
} = commandsModule as {
  getCommand: (
    name: string,
  ) =>
    | ((ctx: unknown, args: string[]) => Promise<{ content: string }> | { content: string })
    | undefined
  getCommandNames: () => string[]
  parseSlashCommand: (input: string) => { command: string; args: string[] }
  isSubcommandRouter: (handler: unknown) => boolean
  unknownCommandMessage: (command: string) => string
  SELF_ROUTING_PARENTS: ReadonlySet<string>
}

const multiWord = () => getCommandNames().filter((name) => name.includes(' '))

describe('multi-word command reachability', () => {
  it('every multi-word command has a registered parent handler', () => {
    const missing = multiWord().filter((name) => !getCommand(parseSlashCommand(name).command))
    expect(missing, `commands with no parent:\n${missing.join('\n')}`).toEqual([])
  })

  it('every multi-word command is reached by a subcommand router (or its parent reads args)', () => {
    const unrouted: string[] = []
    for (const name of multiWord()) {
      const { command, args } = parseSlashCommand(name)
      const parent = getCommand(command)
      if (!parent) {
        unrouted.push(`${name} — no parent handler`)
        continue
      }
      if (SELF_ROUTING_PARENTS.has(command)) continue
      if (!isSubcommandRouter(parent)) {
        unrouted.push(`${name} — parent ${command} is not a router`)
        continue
      }
      // The router looks the subcommand up by name; prove that lookup resolves.
      if (!getCommand(`${command} ${args[0]}`)) {
        unrouted.push(`${name} — router lookup cannot resolve it`)
      }
    }
    expect(unrouted, `unreachable multi-word commands:\n${unrouted.join('\n')}`).toEqual([])
  })

  it('the router marker distinguishes routers from ordinary handlers (negative control)', () => {
    expect(isSubcommandRouter(() => ({ content: 'plain' }))).toBe(false)
    expect(isSubcommandRouter(undefined)).toBe(false)
    // Positive control: at least one real parent is marked.
    expect(isSubcommandRouter(getCommand('/crsi'))).toBe(true)
  })
})

// ── Behavioural routing: parent dispatch lands on the subcommand handler ──

const mkCtx = () =>
  ({
    engine: {
      getRuleEngine: () => undefined,
      getErrorSignatureDB: () => undefined,
      getHookEngine: () => ({ getHookHealth: () => [] }),
    },
  }) as never

describe('parent routers dispatch to their subcommands', () => {
  it('/crsi routes `rules` to the rules handler', async () => {
    const result = await getCommand('/crsi')!(mkCtx(), ['rules'])
    expect(result.content).toBe('CRSI rule engine is not available.')
  })

  it('/sis routes `stats` to the stats handler', async () => {
    const result = await getCommand('/sis')!(mkCtx(), ['stats'])
    expect(result.content).toBe('SIS 自免疫系统未初始化。')
  })

  it('/hooks routes `health` to the health handler', async () => {
    const result = await getCommand('/hooks')!(mkCtx(), ['health'])
    expect(result.content).toContain('All hooks are healthy')
  })

  it('/workflow routes `view` to the view handler', async () => {
    const result = await getCommand('/workflow')!(mkCtx(), ['view', '__no_such_run__'])
    expect(result.content).toContain('not found')
  })

  it('/crsi with no subcommand prints usage instead of staying silent', async () => {
    const result = await getCommand('/crsi')!(mkCtx(), [])
    expect(result.content).toContain('rules')
    expect(result.content).toContain('Usage')
  })
})

describe('unknown slash commands are reported', () => {
  it('names the command and points at /help', () => {
    const message = unknownCommandMessage('/foobar')
    expect(message).toContain('/foobar')
    expect(message).toContain('/help')
  })
})
