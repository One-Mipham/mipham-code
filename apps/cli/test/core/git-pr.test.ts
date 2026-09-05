import { describe, it, expect, vi } from 'vitest'

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }))
vi.mock('node:child_process', () => ({ exec: mockExec }))

import { parseGitPr, prColor, resolveGitPr, type GitPr } from '../../src/core/git-pr'

function pr(overrides: Partial<GitPr> = {}): GitPr {
  return { number: 3, state: 'OPEN', isDraft: false, reviewDecision: '', ...overrides }
}

describe('parseGitPr', () => {
  it('parses the first PR from gh output', () => {
    const json = JSON.stringify([{ number: 3, state: 'OPEN', isDraft: false, reviewDecision: '' }])
    expect(parseGitPr(json)).toEqual({
      number: 3,
      state: 'OPEN',
      isDraft: false,
      reviewDecision: '',
    })
  })

  it('returns null for an empty list', () => {
    expect(parseGitPr('[]')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseGitPr('not json')).toBeNull()
  })

  it('returns null when the first entry has no number', () => {
    expect(parseGitPr('[{"state":"OPEN"}]')).toBeNull()
  })
})

describe('prColor', () => {
  it('maps merged → magenta', () => expect(prColor(pr({ state: 'MERGED' }))).toBe('magenta'))
  it('maps closed → gray', () => expect(prColor(pr({ state: 'CLOSED' }))).toBe('gray'))
  it('maps draft → gray', () => expect(prColor(pr({ isDraft: true }))).toBe('gray'))
  it('maps approved → green', () =>
    expect(prColor(pr({ reviewDecision: 'APPROVED' }))).toBe('green'))
  it('maps changes-requested → yellow', () =>
    expect(prColor(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe('yellow'))
  it('maps open with no review → white', () => expect(prColor(pr())).toBe('white'))
})

describe('resolveGitPr', () => {
  it('resolves the PR on success', async () => {
    mockExec.mockImplementation(
      (_cmd: string, _opts: unknown, cb: (e: null, o: string) => void) => {
        cb(null, JSON.stringify([{ number: 3, state: 'OPEN', isDraft: false, reviewDecision: '' }]))
      },
    )
    await expect(resolveGitPr('main')).resolves.toEqual({
      number: 3,
      state: 'OPEN',
      isDraft: false,
      reviewDecision: '',
    })
  })

  it('returns null when gh fails', async () => {
    mockExec.mockImplementation(
      (_cmd: string, _opts: unknown, cb: (e: Error, o: string) => void) => {
        cb(new Error('gh not found'), '')
      },
    )
    await expect(resolveGitPr('main')).resolves.toBeNull()
  })
})
