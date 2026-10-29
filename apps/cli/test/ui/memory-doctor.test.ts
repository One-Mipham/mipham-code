import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getCommand } from '../../src/ui/commands'
import type { CommandContext } from '../../src/ui/commands'

/** `homedir()` is redirected to a temp dir by vitest.setup.ts, so this is sandboxed. */
const MEMORY_DIR = join(homedir(), '.mipham', 'memory')

async function runMemory(args: string[]): Promise<string> {
  const handler = getCommand('/memory')
  if (!handler) throw new Error('/memory is not registered')
  const { content } = await handler({} as CommandContext, args)
  return content
}

beforeEach(() => {
  rmSync(MEMORY_DIR, { recursive: true, force: true })
  mkdirSync(MEMORY_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(MEMORY_DIR, { recursive: true, force: true })
})

describe('/memory doctor', () => {
  it('is reachable from /memory and reports a consistent store', async () => {
    writeFileSync(
      join(MEMORY_DIR, 'alpha.md'),
      '---\nname: alpha\ndescription: d\nmetadata:\n  type: user\n  relevance: [a]\n---\nbody\n',
      'utf-8',
    )
    writeFileSync(
      join(MEMORY_DIR, 'MEMORY.md'),
      '# Memory Index\n\n- [alpha](alpha.md) — d\n',
      'utf-8',
    )

    const out = await runMemory(['doctor'])
    expect(out).toContain('Memory Doctor')
    expect(out).toContain('consistent')
  })

  it('names the file and the reason for an entry the loader skips', async () => {
    writeFileSync(join(MEMORY_DIR, 'stray.md'), 'no frontmatter here\n', 'utf-8')

    const out = await runMemory(['doctor'])
    expect(out).toContain('stray.md')
    expect(out).toContain('no frontmatter')
  })

  it('does not touch any file in the store', async () => {
    writeFileSync(join(MEMORY_DIR, 'stray.md'), 'no frontmatter here\n', 'utf-8')
    const before = readdirSync(MEMORY_DIR).map((f) => [
      f,
      readFileSync(join(MEMORY_DIR, f), 'utf-8'),
    ])

    await runMemory(['doctor'])

    const after = readdirSync(MEMORY_DIR).map((f) => [
      f,
      readFileSync(join(MEMORY_DIR, f), 'utf-8'),
    ])
    expect(after).toEqual(before)
  })
})
