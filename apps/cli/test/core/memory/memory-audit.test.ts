import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { auditMemoryDir } from '../../../src/core/memory/memory-audit'
import { MemoryManager } from '../../../src/core/memory/memory-manager'

const TEST_DIR = join(tmpdir(), 'mipham-memory-audit-' + Date.now())

/** Write a memory file by hand — exactly the way a person editing the store would. */
function writeMemory(file: string, name: string | null, body: string): void {
  const front =
    name === null
      ? ''
      : `---\nname: ${name}\ndescription: test\ntype: reference\nrelevance: [a]\n---\n`
  writeFileSync(join(TEST_DIR, file), `${front}${body}\n`, 'utf-8')
}

function writeIndex(names: string[]): void {
  const lines = ['# Memory Index', '', '_Last updated: now_', '']
  for (const name of names) lines.push(`- [${name}](${name}.md) — test`)
  writeFileSync(join(TEST_DIR, 'MEMORY.md'), lines.join('\n') + '\n', 'utf-8')
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('auditMemoryDir', () => {
  it('reports nothing for a store the MemoryManager itself wrote', () => {
    const mm = new MemoryManager(TEST_DIR)
    mm.write('alpha', 'User prefers TypeScript. See [[beta]].', {
      type: 'user',
      relevance: ['style'],
    })
    mm.write('beta', 'Build with pnpm.', { type: 'project', relevance: ['build'] })

    expect(auditMemoryDir(TEST_DIR)).toEqual([])
  })

  it('reports nothing when the store does not exist', () => {
    expect(auditMemoryDir(join(TEST_DIR, 'missing'))).toEqual([])
  })

  it('flags a file with no frontmatter — the loader silently drops it', () => {
    writeMemory('stray.md', null, 'just some text')

    const issues = auditMemoryDir(TEST_DIR)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.kind).toBe('invisible')
    expect(issues[0]!.subject).toBe('stray.md')
    expect(issues[0]!.detail).toContain('frontmatter')
  })

  it('flags a file whose frontmatter has no name', () => {
    writeFileSync(join(TEST_DIR, 'nameless.md'), '---\ndescription: x\n---\nbody\n', 'utf-8')

    const issues = auditMemoryDir(TEST_DIR)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.kind).toBe('invisible')
    expect(issues[0]!.detail).toContain('name')
  })

  it('flags two files declaring the same name — one of them is unreachable', () => {
    writeMemory('a.md', 'shared', 'first body')
    writeMemory('b.md', 'shared', 'second body')
    writeIndex(['shared'])

    const dupes = auditMemoryDir(TEST_DIR).filter((i) => i.kind === 'duplicate-name')
    expect(dupes).toHaveLength(1)
    expect(dupes[0]!.subject).toBe('shared')
    expect(dupes[0]!.detail).toContain('a.md')
    expect(dupes[0]!.detail).toContain('b.md')
  })

  it('flags a wikilink to a memory that does not exist', () => {
    writeMemory('alpha.md', 'alpha', 'links to [[ghost]]')
    writeIndex(['alpha'])

    const links = auditMemoryDir(TEST_DIR).filter((i) => i.kind === 'broken-link')
    expect(links).toHaveLength(1)
    expect(links[0]!.subject).toBe('ghost')
    expect(links[0]!.detail).toContain('alpha.md')
  })

  it('does not flag a wikilink that resolves', () => {
    writeMemory('alpha.md', 'alpha', 'links to [[beta]]')
    writeMemory('beta.md', 'beta', 'the target')
    writeIndex(['alpha', 'beta'])

    expect(auditMemoryDir(TEST_DIR).filter((i) => i.kind === 'broken-link')).toEqual([])
  })

  it('flags an index that omits a memory', () => {
    writeMemory('alpha.md', 'alpha', 'body')
    writeIndex([])

    const drift = auditMemoryDir(TEST_DIR).filter((i) => i.kind === 'index-drift')
    expect(drift).toHaveLength(1)
    expect(drift[0]!.subject).toBe('alpha')
    expect(drift[0]!.detail).toContain('missing')
  })

  it('flags an index entry whose memory is gone', () => {
    writeMemory('alpha.md', 'alpha', 'body')
    writeIndex(['alpha', 'removed'])

    const drift = auditMemoryDir(TEST_DIR).filter((i) => i.kind === 'index-drift')
    expect(drift).toHaveLength(1)
    expect(drift[0]!.subject).toBe('removed')
    expect(drift[0]!.detail).toContain('stale')
  })
})
