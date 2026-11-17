/**
 * `/code-review`, `/simplify`, `/verify`, `/review` and `/diff` used
 * `git diff --stat` (unstaged tracked files only). After `git add`, every one
 * of them claimed there were no changes. Staged changes and untracked files
 * must be visible.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExecSync } = vi.hoisted(() => ({ mockExecSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execSync: mockExecSync }))

const { getCommand } = (await import('../../src/ui/commands')) as unknown as {
  getCommand: (
    name: string,
  ) =>
    | ((
        ctx: unknown,
        args: string[],
      ) =>
        | Promise<{ content: string; forwardToAI?: string }>
        | { content: string; forwardToAI?: string })
    | undefined
}

const mkCtx = () => ({ engine: { getTools: () => new Map() } }) as never

beforeEach(() => {
  mockExecSync.mockReset()
  mockExecSync.mockImplementation((command: string) => {
    if (command.includes('--stat HEAD')) {
      return ' src/staged.ts | 2 ++\n 1 file changed, 2 insertions(+)\n'
    }
    if (command.includes('ls-files --others')) return 'brand-new.ts\n'
    if (command.includes('--no-color HEAD')) return 'diff --git a/src/staged.ts\n+added line\n'
    if (command === 'git diff --stat') return ''
    return ''
  })
})

describe('git change visibility', () => {
  it('/review sees staged changes (uses HEAD as the base)', async () => {
    const result = await getCommand('/review')!(mkCtx(), [])
    expect(result.content).toContain('src/staged.ts')
    expect(result.content).toContain('brand-new.ts')
    expect(result.forwardToAI).toBeDefined()
    const commands = mockExecSync.mock.calls.map((c) => String(c[0]))
    expect(commands).toContain('git diff --stat HEAD')
    expect(commands).not.toContain('git diff --stat')
  })

  it('/simplify and /verify get the same visibility', async () => {
    for (const name of ['/simplify', '/verify']) {
      const result = await getCommand(name)!(mkCtx(), [])
      expect(result.content, name).toContain('src/staged.ts')
      expect(result.content, name).toContain('brand-new.ts')
    }
  })

  it('/diff shows staged hunks and lists untracked files', async () => {
    const result = await getCommand('/diff')!(mkCtx(), [])
    expect(result.content).toContain('+added line')
    expect(result.content).toContain('brand-new.ts')
  })

  it('still reports clean when there is genuinely nothing', async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('ls-files --others')) return ''
      return ''
    })
    const result = await getCommand('/review')!(mkCtx(), [])
    expect(result.content.toLowerCase()).toContain('no uncommitted changes')
  })
})
