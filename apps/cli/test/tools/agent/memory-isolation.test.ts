import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// The Memory tool must resolve its storage dir via node:os `homedir()` — NOT
// via `process.env.HOME` — so tests (and the E2E suite) can isolate it with
// `vi.mock('node:os')`. Regression guard for the "Alice" leak: the E2E test's
// "My name is Alice" prompt wrote a real ~/.mipham/memory/user-name.md because
// this tool read process.env.HOME, which the homedir mock could not override.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-memory-tool`,
  }
})

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ToolContext } from '../../../src/shared'
import { memoryTool } from '../../../src/tools/agent/memory'

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

describe('Memory tool — storage path isolation', () => {
  const mockedMemory = join(homedir(), '.mipham', 'memory')

  beforeAll(() => {
    try {
      rmSync(join(homedir(), '.mipham'), { recursive: true, force: true })
    } catch {
      /* ok */
    }
  })

  afterAll(() => {
    try {
      rmSync(join(homedir(), '.mipham'), { recursive: true, force: true })
    } catch {
      /* ok */
    }
  })

  it('writes under homedir(), never under process.env.HOME', async () => {
    const result = await memoryTool.execute(
      { action: 'write', name: 'isolation-probe', content: 'The user name probe.' },
      ctx,
    )
    expect(result.success).toBe(true)

    // Written under the mocked homedir...
    expect(existsSync(join(mockedMemory, 'isolation-probe.md'))).toBe(true)

    // ...and NOT leaked into the real ~/.mipham/memory/.
    const realHome = process.env.HOME
    if (realHome) {
      expect(existsSync(join(realHome, '.mipham', 'memory', 'isolation-probe.md'))).toBe(false)
    }
  })
})
