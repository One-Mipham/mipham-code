/**
 * P1/P2 leftovers:
 *  - /focus toggles instead of always setting true
 *  - /branch stops promising a "future release"
 *  - /crsi health scores evidence, not presence
 *  - /pr-comments reads real PR comments when gh can answer
 *  - /commit /pr /issue actually hand the drafting to the model
 *  - /push says out loud that it only reports
 *  - /workflow watch reads the live run id
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

const { mockExecSync } = vi.hoisted(() => ({ mockExecSync: vi.fn() }))
vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
  execFileSync: vi.fn(),
}))

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
const { getEventBus } = (await import('../../src/workflow/event-bus')) as unknown as {
  getEventBus: () => { startRun: (id: string) => void }
}

type Result = { content: string; forwardToAI?: string }

const call = async (name: string, ctx: unknown, args: string[] = []): Promise<Result> =>
  (await getCommand(name)!(ctx, args)) as Result

/** Fake Bun.spawn that answers by argv, like the git-locale fixture. */
function fakeGit(outputs: (args: string[]) => string) {
  vi.stubGlobal('Bun', {
    spawn: (argv: string[]) => ({
      exited: Promise.resolve(0),
      stdout: new Response(outputs(argv.slice(1))).body,
      kill: () => {},
    }),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  mockExecSync.mockReset()
})

describe('/focus', () => {
  it('turns focus OFF when it is already on', async () => {
    const setFocusMode = vi.fn()
    const result = await call('/focus', { getFocusMode: () => true, setFocusMode })
    expect(setFocusMode).toHaveBeenCalledWith(false)
    expect(result.content).toContain('OFF')
  })

  it('turns focus ON when it is off', async () => {
    const setFocusMode = vi.fn()
    const result = await call('/focus', { getFocusMode: () => false, setFocusMode })
    expect(setFocusMode).toHaveBeenCalledWith(true)
    expect(result.content).toContain('ON')
  })
})

describe('/branch wording', () => {
  const ctx = {
    engine: {
      getContext: () => ({
        getMessages: () => [{ role: 'user', content: 'hi' }],
        saveCheckpoint: () => 3,
      }),
    },
  }

  it('does not promise a future release for separate sessions', async () => {
    const result = await call('/branch', ctx, ['topic'])
    expect(result.content.toLowerCase()).not.toContain('future release')
    expect(result.content).not.toContain('未来版本')
    // It must still say what it actually did.
    expect(result.content).toContain('checkpoint')
  })
})

describe('/crsi health scoring', () => {
  const rules = [
    { id: 'a', source: 'builtin', enabled: true },
    { id: 'b', source: 'managed', enabled: true },
  ]

  it('does not award 50 points for merely having an engine', async () => {
    const ctx = {
      engine: {
        getRuleEngine: () => ({ getActiveRules: () => rules }),
        getEffectivenessTracker: () => ({ allRules: [], getEffectiveness: () => undefined }),
      },
    }
    const result = await call('/crsi health', ctx)
    // 2 rules → 25 (evidence) + 0 (no interception data) = 25
    expect(result.content).toContain('25/100')
    expect(result.content).not.toContain('50/50')
    expect(result.content).toContain('计分依据')
  })

  it('scores each half from its own data', async () => {
    const ctx = {
      engine: {
        getRuleEngine: () => ({ getActiveRules: () => rules }),
        getEffectivenessTracker: () => ({
          allRules: [],
          getEffectiveness: () => ({ appliedCount: 10, successAfterCount: 8 }),
        }),
        getErrorSignatureDB: () => ({
          getStats: () => ({ total: 5, active: 4, degraded: 1, retired: 0, avgSuccessRate: 0.6 }),
        }),
      },
    }
    const result = await call('/crsi health', ctx)
    // CRSI: 25 rules + 25*0.8 = 45 ; SIS: 25 memory + 25*0.6 = 40 ; total 85
    expect(result.content).toContain('45/50')
    expect(result.content).toContain('40/50')
    expect(result.content).toContain('85/100')
  })
})

describe('/pr-comments', () => {
  const gitAnswers = (command: string): string => {
    if (command.includes('branch --show-current')) return 'feat-x\n'
    if (command.includes('remote show origin')) return '  HEAD branch: main\n'
    if (command.includes('diff --stat')) return ' src/a.ts | 2 ++\n'
    if (command.includes('log --oneline')) return 'abc123 add a thing\n'
    return ''
  }

  it('reads review comments from gh when it can', async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command.startsWith('gh pr view')) {
        return JSON.stringify({
          number: 7,
          title: 'Add a thing',
          url: 'https://example.test/pr/7',
          reviews: [{ author: { login: 'alice' }, state: 'APPROVED', body: 'LGTM' }],
          comments: [{ author: { login: 'bob' }, body: 'please split this function' }],
        })
      }
      return gitAnswers(command)
    })

    const result = await call('/pr-comments', {})
    expect(result.content).toContain('PR #7')
    expect(result.content).toContain('@alice')
    expect(result.content).toContain('LGTM')
    expect(result.content).toContain('@bob')
    expect(result.content).toContain('please split this function')
  })

  it('says why comments are unavailable instead of silently showing only branch info', async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command.startsWith('gh pr view')) {
        const err = new Error('Command failed: gh pr view') as Error & {
          status: number
          stderr: string
        }
        err.status = 127
        err.stderr = 'gh: command not found'
        throw err
      }
      return gitAnswers(command)
    })

    const result = await call('/pr-comments', {})
    expect(result.content).toContain('gh CLI not found')
    expect(result.content).toContain('Branch:')
  })
})

describe('git workflow commands have a landing point', () => {
  it('/commit hands the staged diff to the model', async () => {
    fakeGit((args) => {
      if (args[0] === 'diff' && args.includes('--cached') && args.includes('--stat'))
        return ' src/a.ts | 1 +\n'
      if (args[0] === 'diff' && args.includes('--cached')) return '+const x = 1\n'
      return ''
    })
    const result = await call('/commit', {})
    expect(result.forwardToAI).toBeDefined()
    expect(result.forwardToAI).toContain('Conventional Commits')
    expect(result.forwardToAI).toContain('const x = 1')
  })

  it('/pr drafts a title and body from the commits and diff', async () => {
    fakeGit((args) => {
      if (args[0] === 'branch') return 'feat-x\n'
      if (args[0] === 'remote') return '  HEAD branch: main\n'
      if (args[0] === 'log') return 'abc123 add a thing\n'
      if (args[0] === 'diff') return ' src/a.ts | 1 +\n'
      return ''
    })
    const result = await call('/pr', {})
    expect(result.forwardToAI).toBeDefined()
    expect(result.forwardToAI).toContain('abc123')
    expect(result.content).not.toContain('type "create a pull request"')
  })

  it('/issue drafts from the words the user typed', async () => {
    const result = await call('/issue', {}, ['login', 'crashes'])
    expect(result.forwardToAI).toBeDefined()
    expect(result.forwardToAI).toContain('login crashes')
  })

  it('/issue asks for a description instead of forwarding an empty prompt', async () => {
    const result = await call('/issue', {}, [])
    expect(result.forwardToAI).toBeUndefined()
    expect(result.content.toLowerCase()).toContain('describe')
  })

  it('/push reports and never forwards a push instruction', async () => {
    fakeGit((args) => {
      if (args[0] === 'branch') return 'feat-x\n'
      if (args[0] === 'rev-list') return '2\n'
      return ''
    })
    const result = await call('/push', {})
    expect(result.forwardToAI).toBeUndefined()
    expect(result.content).toContain('never pushes')
  })
})

describe('/workflow watch', () => {
  it('reports no active run when none was started in this process', async () => {
    const result = await call('/workflow watch', {})
    expect(result.content).toContain('No workflow is running in this process')
    expect(result.content).not.toContain('No active workflow detected')
  })

  it('names the run that is actually active', async () => {
    getEventBus().startRun('run-live-1')
    const result = await call('/workflow watch', {})
    expect(result.content).toContain('run-live-1')
    expect(result.content).toContain('/workflow view run-live-1')
  })
})
