import { describe, it, expect, vi } from 'vitest'

// Override the global homedir() mock from vitest.setup.ts with a home that
// contains a *user name*, so "the user name never reaches the payload" is a
// real assertion rather than a vacuous one. The global mock points at
// `${tmpdir()}/mipham-test-home`, which has no user name to leak.
// Mutable so the Windows-separator case can be driven from the same file —
// `vi.hoisted` lifts the holder above the imports that trigger the factory.
const homeRef = vi.hoisted(() => ({ value: '/Users/zqxuser' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => homeRef.value }
})

import {
  redactText,
  redactStack,
  hashMessage,
  runtimeTag,
  MAX_STACK_FRAMES,
} from '../../src/telemetry/redact'

const HOME = '/Users/zqxuser'
const CWD = `${HOME}/proj`
const USERNAME = 'zqxuser'

describe('redactText', () => {
  it('replaces cwd before home, so the project directory name does not leak', () => {
    // Ordering is load-bearing: home-first would yield `~/proj/src/a.ts`, which
    // discloses the project name. cwd-first yields `<cwd>/src/a.ts`.
    const out = redactText(`${CWD}/src/a.ts:12:34`, CWD)
    expect(out).toBe('<cwd>/src/a.ts:12:34')
    expect(out).not.toContain('proj')
  })

  it("collapses the first segment under home, so the user's own naming does not leak", () => {
    // Home alone would render as `~/acme-secret-merger/src/a.ts`. The dictionary
    // promises no project names, so the segment after `~` is collapsed too.
    expect(redactText(`${HOME}/acme-secret-merger/src/a.ts:1:1`, CWD)).toBe('~/<dir>/src/a.ts:1:1')
  })

  it('collapses the segment after ~ on Windows-style stacks too', () => {
    // The repo ships bun-windows binaries, so the backslash path is real.
    // Prefix substitution only — the original separator is preserved, which is
    // why the expectations below use backslashes after the markers.
    homeRef.value = 'C:\\Users\\zqxuser'
    try {
      expect(redactText('C:\\Users\\zqxuser\\proj\\a.ts:1:1', 'C:\\Users\\zqxuser\\proj')).toBe(
        '<cwd>\\a.ts:1:1',
      )
      expect(redactText('C:\\Users\\zqxuser\\other\\a.ts:1:1', 'C:\\Users\\zqxuser\\proj')).toBe(
        '~\\<dir>\\a.ts:1:1',
      )
    } finally {
      homeRef.value = '/Users/zqxuser'
    }
  })

  it('replaces every occurrence, not just the first', () => {
    const out = redactText(`${CWD}/a.ts then ${CWD}/b.ts`, CWD)
    expect(out).toBe('<cwd>/a.ts then <cwd>/b.ts')
  })

  it('never emits the user name', () => {
    const out = redactText(`${HOME}/proj/src/a.ts:1:1 and ${HOME}/.mipham/x`, CWD)
    expect(out).not.toContain(USERNAME)
  })

  it('leaves system/package absolute paths alone — they hold no user data', () => {
    const sys = '/usr/local/lib/node_modules/@miphamai/cli/src/x.ts:9:9'
    expect(redactText(sys, CWD)).toBe(sys)
  })

  it('ignores a root-level cwd or home rather than blanking every path', () => {
    // A bare `/` prefix would make the regex match every absolute path.
    const p = '/tmp/thing/a.ts'
    expect(redactText(p, '/')).toBe(p)
  })

  it('treats regex metacharacters in the path literally', () => {
    const cwd = '/Users/zqxuser/a+b (copy)'
    expect(redactText(`${cwd}/x.ts`, cwd)).toBe('<cwd>/x.ts')
  })
})

describe('redactStack', () => {
  const stack = [
    `TypeError: ENOENT: no such file, open '${CWD}/secret.txt'`,
    `    at readIt (${CWD}/src/a.ts:12:34)`,
    `    at Object.<anonymous> (${HOME}/.mipham/plugins/b.js:5:1)`,
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '',
  ].join('\n')

  it('drops the message line entirely — it embeds paths and user data', () => {
    const { frames } = redactStack(stack, { cwd: CWD })
    expect(frames.join('\n')).not.toContain('ENOENT')
    expect(frames.join('\n')).not.toContain('secret.txt')
  })

  it('keeps frame names and line:col while redacting the path', () => {
    const { frames } = redactStack(stack, { cwd: CWD })
    expect(frames).toContain('at readIt (<cwd>/src/a.ts:12:34)')
  })

  it('leaves node-internal frames intact', () => {
    const { frames } = redactStack(stack, { cwd: CWD })
    expect(frames).toContain(
      'at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    )
  })

  it('emits no user name and no cwd plaintext anywhere in the output', () => {
    const { frames } = redactStack(stack, { cwd: CWD })
    const joined = frames.join('\n')
    expect(joined).not.toContain(USERNAME)
    expect(joined).not.toContain(CWD)
  })

  it('truncates to maxFrames but reports the pre-truncation frameCount', () => {
    const many = [
      'Error: boom',
      ...Array.from({ length: 40 }, (_, i) => `    at fn${i} (${CWD}/f${i}.ts:1:1)`),
    ].join('\n')

    const { frames, frameCount } = redactStack(many, { cwd: CWD })
    expect(frames).toHaveLength(MAX_STACK_FRAMES)
    // The count bounds what truncation threw away.
    expect(frameCount).toBe(40)
    expect(frames[0]).toBe('at fn0 (<cwd>/f0.ts:1:1)')
  })

  it('defaults cwd to process.cwd()', () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(CWD)
    try {
      const { frames } = redactStack(`Error: x\n    at fn (${CWD}/a.ts:1:1)`)
      expect(frames).toEqual(['at fn (<cwd>/a.ts:1:1)'])
    } finally {
      spy.mockRestore()
    }
  })

  it('returns an empty result for a stack with no frames', () => {
    expect(redactStack('Error: x', { cwd: CWD })).toEqual({ frames: [], frameCount: 0 })
  })
})

describe('hashMessage', () => {
  it('is 16 lowercase hex chars', () => {
    expect(hashMessage('boom')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic and separating', () => {
    expect(hashMessage('boom')).toBe(hashMessage('boom'))
    expect(hashMessage('boom')).not.toBe(hashMessage('boom '))
  })

  it('does not reveal the message', () => {
    expect(hashMessage('secret-path-here')).not.toContain('secret')
  })
})

describe('runtimeTag', () => {
  it('reports node@<major> under vitest', () => {
    expect(runtimeTag()).toMatch(/^node@\d+$/)
  })
})
