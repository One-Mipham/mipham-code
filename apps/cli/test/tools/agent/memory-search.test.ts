import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Isolate the Memory tool's storage dir (same pattern as memory-isolation.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-memory-search` }
})

import type { ToolContext } from '../../../src/shared'
import { memoryTool } from '../../../src/tools/agent/memory'

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'm',
}

describe('Memory tool — search action', () => {
  beforeAll(async () => {
    rmSync(join(homedir(), '.mipham'), { recursive: true, force: true })
    await memoryTool.execute(
      { action: 'write', name: 'ts-pref', content: 'User prefers TypeScript over JavaScript' },
      ctx,
    )
    await memoryTool.execute(
      { action: 'write', name: 'py-pref', content: 'Project uses Python 3.12' },
      ctx,
    )
  })

  afterAll(() => {
    rmSync(join(homedir(), '.mipham'), { recursive: true, force: true })
  })

  it('returns memories matching the query', async () => {
    const result = await memoryTool.execute({ action: 'search', query: 'TypeScript' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('ts-pref')
  })

  it('returns empty when nothing matches', async () => {
    const result = await memoryTool.execute(
      { action: 'search', query: 'zzz-nothing-matches-this-topic' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('no matching memories')
  })

  it('requires a query', async () => {
    const result = await memoryTool.execute({ action: 'search' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('query is required')
  })
})
