import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { rmSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  hasProposedProse,
  appendProseProposal,
  clearProseProposals,
} from '../../src/core/crsi-producer'

// Isolate the prose-proposals ledger from the real ~/.mipham.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-prose-ledger`,
  }
})

beforeEach(() => {
  // 清空 ledger，避免跨运行残留（tmpdir 不自动清理）。
  rmSync(join(homedir(), '.mipham', 'crsi', 'prose-proposals.jsonl'), { force: true })
})

describe('prose proposal ledger', () => {
  it('hasProposedProse is false before append, true after', () => {
    const id = 'prose-timeout-abc'
    expect(hasProposedProse(id)).toBe(false)
    appendProseProposal({
      id,
      filePath: 'apps/cli/skills/standard/memory.SKILL.md',
      timestamp: 'ts',
    })
    expect(hasProposedProse(id)).toBe(true)
  })

  it('does not match a different id', () => {
    appendProseProposal({ id: 'prose-timeout-abc', filePath: 'x.md', timestamp: 'ts' })
    expect(hasProposedProse('prose-timeout-other')).toBe(false)
  })

  it('ignores malformed ledger lines', () => {
    appendProseProposal({ id: 'prose-timeout-abc', filePath: 'x.md', timestamp: 'ts' })
    const file = join(homedir(), '.mipham', 'crsi', 'prose-proposals.jsonl')
    appendFileSync(file, 'not-json\n', 'utf-8')
    expect(hasProposedProse('prose-timeout-abc')).toBe(true)
    expect(hasProposedProse('not-json')).toBe(false)
  })
})

describe('clearProseProposals', () => {
  it('empties the ledger and returns the cleared record count', () => {
    appendProseProposal({ id: 'prose-timeout-a', filePath: 'x.md', timestamp: 'ts' })
    appendProseProposal({ id: 'prose-timeout-b', filePath: 'y.md', timestamp: 'ts' })
    expect(hasProposedProse('prose-timeout-a')).toBe(true)

    const cleared = clearProseProposals()
    expect(cleared).toBe(2)
    expect(hasProposedProse('prose-timeout-a')).toBe(false)
    expect(hasProposedProse('prose-timeout-b')).toBe(false)
  })

  it('returns 0 when the ledger is absent', () => {
    expect(clearProseProposals()).toBe(0)
  })
})
