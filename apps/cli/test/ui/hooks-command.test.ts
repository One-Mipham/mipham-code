/**
 * `/hooks` — the listing must not pass for the live set.
 *
 * Project-level hooks are shell commands this process spawns, so they are gated
 * on workspace trust. This command *displays* the configured list, which means
 * it sees them even when the gate is shut — so it has to say which entries came
 * from the project file and that those will not run. Listing them silently was
 * the defect: the display said "configured" and the engine said nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocked rather than real: what matters here is which *source* each entry came
// from, and the real loader merges the two files into one provenance-free list.
// The fixture below keeps them apart and answers each question the loader
// answers, so a command that stops asking the second one stops getting an answer.
let projectHooks: Record<string, unknown[]> = {}
let userHooks: Record<string, unknown[]> = {}

vi.mock('../../src/config/loader', () => ({
  loadSettingsJson: (_cwd: string, opts?: { includeProjectHooks?: boolean }) => {
    const permissions = { allow: [], deny: [] }
    if (!opts?.includeProjectHooks) return { hooks: userHooks, permissions }
    const hooks: Record<string, unknown[]> = {}
    for (const src of [projectHooks, userHooks]) {
      for (const [event, entries] of Object.entries(src)) {
        hooks[event] = [...(hooks[event] ?? []), ...entries]
      }
    }
    return { hooks, permissions, projectHooks }
  },
  loadCrossSessionConfig: () => ({}),
  tryRestoreFromBackup: () => false,
}))

let trusted = false
vi.mock('../../src/core/workspace-trust', () => ({
  getWorkspaceTrust: () => ({ isTrusted: () => trusted }),
}))

const { getCommand } = (await import('../../src/ui/commands')) as unknown as {
  getCommand: (
    name: string,
  ) => ((ctx: unknown, args: string[]) => Promise<{ content: string }>) | undefined
}

// No `t`, so `resolveT` falls back to the module default (en-US).
const ctx = {} as Parameters<NonNullable<ReturnType<typeof getCommand>>>[0]

async function renderHooks(): Promise<string> {
  const handler = getCommand('/hooks')
  expect(handler).toBeDefined()
  return (await handler!(ctx, [])).content
}

const lineFor = (out: string, command: string): string => {
  const line = out.split('\n').find((l) => l.includes(command))
  expect(line, `no line rendered for ${command}`).toBeDefined()
  return line!
}

describe('/hooks — project hooks are marked when the gate is shut', () => {
  beforeEach(() => {
    trusted = false
    projectHooks = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'p.sh' }] }],
    }
    userHooks = {
      PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'u.sh' }] }],
    }
  })

  it('marks project entries as not running while leaving user entries unmarked', async () => {
    const out = await renderHooks()

    const project = lineFor(out, 'p.sh')
    const user = lineFor(out, 'u.sh')

    expect(project).toContain('will not run')
    // The marker is about the *gate*, not about the listing: both are shown.
    expect(user).not.toContain('will not run')
    // And the display has to name the source, or "will not run" would be
    // attached to an entry the reader cannot identify.
    expect(project).toContain('project')
    expect(user).toContain('user')
  })

  it('marks nothing when the workspace is trusted', async () => {
    trusted = true

    const out = await renderHooks()

    expect(out).toContain('p.sh')
    expect(out).toContain('u.sh')
    expect(out).not.toContain('will not run')
  })

  it('marks nothing when there are no project hooks to mark', async () => {
    projectHooks = {}

    const out = await renderHooks()

    // A gate that withheld nothing is not news: announcing it here would be the
    // same defect as `projectHooksSkipped` reporting a skip that never happened.
    expect(out).toContain('u.sh')
    expect(out).not.toContain('will not run')
  })
})
