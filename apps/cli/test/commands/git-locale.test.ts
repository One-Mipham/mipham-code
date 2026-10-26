import { describe, it, expect, vi, afterEach } from 'vitest'
import { getCommand } from '../../src/ui/commands'

/**
 * `/pr` derives the base branch from `git remote show origin`, whose header is
 * **localized** (`HEAD branch:` / `HEAD 分支：`). The regex only knows the English
 * spelling, so on a machine whose git speaks Chinese the base silently became
 * `main`. The fix is to spawn git with `LC_ALL=C`; this fixture plays a git that
 * localizes its output unless the caller asks otherwise, so removing the env
 * makes the assertion fail rather than pass for the wrong reason.
 */
function fakeBunSpawn(outputs: (argv: string[]) => string, seen: Array<Record<string, unknown>>) {
  return vi.stubGlobal('Bun', {
    spawn: (argv: string[], opts: Record<string, unknown>) => {
      seen.push(opts)
      const text = outputs(argv)
      return {
        exited: Promise.resolve(0),
        stdout: new Response(text).body,
        kill: () => {},
      }
    },
  })
}

describe('/pr — base branch parsing under a non-English git', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forces the C locale so `HEAD branch:` stays matchable', async () => {
    const seen: Array<Record<string, unknown>> = []
    fakeBunSpawn((argv) => {
      const args = argv.slice(1)
      if (args[0] === 'branch') return 'feat-x\n'
      if (args[0] === 'remote' && args[1] === 'show') {
        const env = seen.at(-1)?.env as Record<string, string> | undefined
        // What a localized git would print otherwise.
        return env?.LC_ALL === 'C' ? '  HEAD branch: trunk\n' : '  HEAD 分支：dev\n'
      }
      return ''
    }, seen)

    const { content } = await getCommand('/pr')!(
      {} as Parameters<NonNullable<ReturnType<typeof getCommand>>>[0],
      [],
    )

    expect(content).toContain('Branch: feat-x → trunk')
    expect(content).not.toContain('→ main')
    for (const opts of seen) {
      expect((opts.env as Record<string, string>).LC_ALL).toBe('C')
    }
  })
})
