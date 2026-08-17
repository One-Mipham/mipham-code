import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import type { ToolContext } from '../../src/shared'
import { Context } from '../../src/vajra'
import { collectTools } from '../../src/tools/seam'
import { createReadTool, readToolService } from '../../src/tools/file/read'
import { writeTool } from '../../src/tools/file/write'
import { editTool } from '../../src/tools/file/edit'
import { globTool } from '../../src/tools/file/glob'
import { grepTool, runSearch } from '../../src/tools/file/grep'

const readTool = createReadTool()

// ── Test context ──

let tmpDir: string
let ctx: ToolContext

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mipham-test-'))
  ctx = { cwd: tmpDir, sessionId: 'test-session', provider: 'test', model: 'test-model' }
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Mock Bun.spawn to actually run the command (grep tests need real rg/grep output). */
function mockRealSpawn() {
  vi.spyOn(Bun, 'spawn').mockImplementation((cmd: string[], opts?: { cwd?: string }) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: opts?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? 0))
    })
    const proc = {
      stdout: Readable.toWeb(child.stdout!) as ReadableStream,
      stderr: Readable.toWeb(child.stderr!) as ReadableStream,
      exited,
      get exitCode() {
        return child.exitCode
      },
      kill: () => child.kill(),
    }
    return proc as any
  })
}

// ============================================================
// Read Tool
// ============================================================

describe('Read tool definition', () => {
  it('has correct metadata', () => {
    expect(readTool.name).toBe('Read')
    expect(readTool.category).toBe('file')
    expect(readTool.permission).toBe('auto')
  })

  it('requires file_path parameter', () => {
    const params = readTool.parameters as { required: string[] }
    expect(params.required).toContain('file_path')
  })

  it('has offset and limit as optional parameters', () => {
    const params = readTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('offset')
    expect(params.properties).toHaveProperty('limit')
  })
})

describe('Read tool execution', () => {
  it('returns error for non-existent file', async () => {
    const nonExistent = join(tmpDir, 'does-not-exist.txt')
    const result = await readTool.execute({ file_path: nonExistent }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('File not found')
  })

  it('returns error for directory path', async () => {
    const result = await readTool.execute({ file_path: tmpDir }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('directory')
  })

  it('reads file content with line numbers', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'line one\nline two\nline three')
    const result = await readTool.execute({ file_path: join(tmpDir, 'test.txt') }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('line one')
    expect(result.content).toContain('line two')
    expect(result.content).toContain('line three')
    // Check line numbering format: "     1\tline one"
    expect(result.content).toMatch(/^\s*1\t/)
  })

  it('supports offset parameter', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'line1\nline2\nline3\nline4\nline5')
    const result = await readTool.execute({ file_path: join(tmpDir, 'test.txt'), offset: 2 }, ctx)
    expect(result.success).toBe(true)
    const lines = result.content.split('\n')
    expect(lines.length).toBeLessThanOrEqual(3) // lines 3,4,5
    expect(result.content).toContain('line3')
    expect(result.content).not.toContain('line1')
  })

  it('supports limit parameter', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'a\nb\nc\nd\ne\nf\ng\nh')
    const result = await readTool.execute({ file_path: join(tmpDir, 'test.txt'), limit: 2 }, ctx)
    expect(result.success).toBe(true)
    const lines = result.content.split('\n')
    expect(lines.length).toBeLessThanOrEqual(2)
  })

  it('defaults to offset 0 and limit 2000', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world')
    const result = await readTool.execute({ file_path: join(tmpDir, 'test.txt') }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('hello world')
  })
})

describe('readToolService (credential injection)', () => {
  it('does not mount without credentials (inject gating)', () => {
    const ctx = new Context()
    const mounted = ctx.mount(readToolService)
    expect(mounted.status()).toBe('inactive')
    expect(collectTools(ctx).has('Read')).toBe(false)
  })

  it('mounts once credentials are provided', () => {
    const ctx = new Context()
    const mounted = ctx.mount(readToolService)
    ctx.provide('credentials', {
      enabled: true,
      files: [],
      output_scrubbing: { enabled: true, patterns: [] },
      env_filter: { enabled: true, patterns: [] },
    })
    expect(mounted.status()).toBe('active')
    expect(collectTools(ctx).has('Read')).toBe(true)
  })
})

// ============================================================
// Write Tool
// ============================================================

describe('Write tool definition', () => {
  it('has correct metadata', () => {
    expect(writeTool.name).toBe('Write')
    expect(writeTool.category).toBe('file')
    expect(writeTool.permission).toBe('ask')
  })

  it('requires file_path and content', () => {
    const params = writeTool.parameters as { required: string[] }
    expect(params.required).toEqual(['file_path', 'content'])
  })
})

describe('Write tool execution', () => {
  it('writes content to a file', async () => {
    const dest = join(tmpDir, 'output.txt')
    const result = await writeTool.execute({ file_path: dest, content: 'Hello Mipham' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('Wrote')
    expect(result.content).toContain(dest)
    const written = readFileSync(dest, 'utf-8')
    expect(written).toBe('Hello Mipham')
  })

  it('creates parent directories automatically', async () => {
    const dest = join(tmpDir, 'deep', 'nested', 'folder', 'output.txt')
    const result = await writeTool.execute({ file_path: dest, content: 'nested content' }, ctx)
    expect(result.success).toBe(true)
    const written = readFileSync(dest, 'utf-8')
    expect(written).toBe('nested content')
  })

  it('overwrites existing file after it has been read', async () => {
    const dest = join(tmpDir, 'existing.txt')
    writeFileSync(dest, 'original')
    ctx.readFiles = new Set()
    await readTool.execute({ file_path: dest }, ctx) // read-first populates readFiles (canonical path)
    await writeTool.execute({ file_path: dest, content: 'updated' }, ctx)
    expect(readFileSync(dest, 'utf-8')).toBe('updated')
  })

  it('blocks overwriting an unread existing file (fail-closed)', async () => {
    const dest = join(tmpDir, 'existing.txt')
    writeFileSync(dest, 'original')
    const result = await writeTool.execute({ file_path: dest, content: 'updated' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('not been read')
    expect(readFileSync(dest, 'utf-8')).toBe('original')
  })

  it('writes empty content', async () => {
    const dest = join(tmpDir, 'empty.txt')
    const result = await writeTool.execute({ file_path: dest, content: '' }, ctx)
    expect(result.success).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe('')
  })
})

// ============================================================
// Edit Tool
// ============================================================

describe('Edit tool definition', () => {
  it('has correct metadata', () => {
    expect(editTool.name).toBe('Edit')
    expect(editTool.category).toBe('file')
    expect(editTool.permission).toBe('ask')
  })

  it('requires file_path, old_string, new_string', () => {
    const params = editTool.parameters as { required: string[] }
    expect(params.required).toEqual(['file_path', 'old_string', 'new_string'])
  })

  it('has replace_all as optional boolean with default false', () => {
    const params = editTool.parameters as { properties: Record<string, unknown> }
    const replaceAll = params.properties.replace_all as { type: string; default: boolean }
    expect(replaceAll.type).toBe('boolean')
    expect(replaceAll.default).toBe(false)
  })
})

describe('Edit tool execution', () => {
  const testFile = () => join(tmpDir, 'edit-test.txt')

  beforeEach(() => {
    writeFileSync(testFile(), 'const hello = "world"\nconst foo = "bar"\n// end')
  })

  it('replaces a single occurrence', async () => {
    const result = await editTool.execute(
      { file_path: testFile(), old_string: '"world"', new_string: '"mipham"' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('Replaced 1 occurrence')
    const updated = readFileSync(testFile(), 'utf-8')
    expect(updated).toContain('const hello = "mipham"')
    expect(updated).not.toContain('"world"')
  })

  it('rejects non-unique matches when replace_all is false', async () => {
    writeFileSync(testFile(), 'hello\nhello\nworld')
    const result = await editTool.execute(
      { file_path: testFile(), old_string: 'hello', new_string: 'hi' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not unique')
  })

  it('replaces all occurrences when replace_all is true', async () => {
    writeFileSync(testFile(), 'hello\nhello\nworld')
    const result = await editTool.execute(
      { file_path: testFile(), old_string: 'hello', new_string: 'hi', replace_all: true },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('Replaced 2 occurrences')
    const updated = readFileSync(testFile(), 'utf-8')
    expect(updated).toBe('hi\nhi\nworld')
  })

  it('errors when old_string not found', async () => {
    const result = await editTool.execute(
      { file_path: testFile(), old_string: 'nonexistent', new_string: 'x' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('replaces with empty string', async () => {
    writeFileSync(testFile(), 'remove THIS word')
    const result = await editTool.execute(
      { file_path: testFile(), old_string: 'THIS ', new_string: '' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(readFileSync(testFile(), 'utf-8')).toBe('remove word')
  })

  it('replaces with multi-line content', async () => {
    writeFileSync(testFile(), '// placeholder')
    const result = await editTool.execute(
      {
        file_path: testFile(),
        old_string: '// placeholder',
        new_string: 'line1\nline2\nline3',
      },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(readFileSync(testFile(), 'utf-8')).toBe('line1\nline2\nline3')
  })

  it('rejects substring-only match (old_string inside larger identifier)', async () => {
    // "user" appears only as a substring of "username" — not a standalone occurrence
    writeFileSync(testFile(), 'const username = "admin"')
    const result = await editTool.execute(
      { file_path: testFile(), old_string: 'user', new_string: 'account' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('rejects substring match at start of identifier', async () => {
    // "get" inside "getUserName" — starts at identifier boundary but ends mid-identifier
    writeFileSync(testFile(), 'getUserName()')
    const result = await editTool.execute(
      { file_path: testFile(), old_string: 'get', new_string: 'fetch' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('rejects substring match at end of identifier', async () => {
    // "Name" inside "getUserName" — starts mid-identifier
    writeFileSync(testFile(), 'getUserName()')
    const result = await editTool.execute(
      { file_path: testFile(), old_string: 'Name', new_string: 'Login' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('allows standalone match when surrounded by non-identifier chars', async () => {
    writeFileSync(testFile(), 'const user = "test"\nconst username = "admin"')
    const result = await editTool.execute(
      { file_path: testFile(), old_string: 'user', new_string: 'account' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(readFileSync(testFile(), 'utf-8')).toBe(
      'const account = "test"\nconst username = "admin"',
    )
  })

  it('replace_all skips substring matches inside larger identifiers', async () => {
    writeFileSync(testFile(), 'user\nusername\nuserAge\nsuper_user\nuser')
    const result = await editTool.execute(
      { file_path: testFile(), old_string: 'user', new_string: 'account', replace_all: true },
      ctx,
    )
    expect(result.success).toBe(true)
    // Only standalone "user" replaced (lines 1 and 5).
    // "username", "userAge", "super_user" are all larger identifiers — skipped.
    expect(readFileSync(testFile(), 'utf-8')).toBe(
      'account\nusername\nuserAge\nsuper_user\naccount',
    )
  })

  it('replace_all returns error when old_string only appears as substring', async () => {
    writeFileSync(testFile(), 'username\nuserAge')
    const result = await editTool.execute(
      { file_path: testFile(), old_string: 'user', new_string: 'account', replace_all: true },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })
})

// ============================================================
// Glob Tool
// ============================================================

describe('Glob tool definition', () => {
  it('has correct metadata', () => {
    expect(globTool.name).toBe('Glob')
    expect(globTool.category).toBe('file')
    expect(globTool.permission).toBe('auto')
  })

  it('requires pattern parameter', () => {
    const params = globTool.parameters as { required: string[] }
    expect(params.required).toEqual(['pattern'])
  })

  it('has path as optional parameter', () => {
    const params = globTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('path')
  })
})

describe('Glob tool execution', () => {
  it('finds files matching a glob pattern', async () => {
    // Create test files
    const srcDir = join(tmpDir, 'src')
    mkdirSync(srcDir)
    writeFileSync(join(srcDir, 'app.ts'), '// app')
    writeFileSync(join(srcDir, 'util.ts'), '// util')
    writeFileSync(join(srcDir, 'readme.md'), '# readme')

    const result = await globTool.execute({ pattern: '**/*.ts', path: tmpDir }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('app.ts')
    expect(result.content).toContain('util.ts')
    expect(result.content).not.toContain('readme.md')
  })

  it('returns (no matches) for empty results', async () => {
    const result = await globTool.execute({ pattern: '**/*.nonexistent', path: tmpDir }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toBe('(no matches)')
  })

  it('defaults path to current directory', async () => {
    writeFileSync(join(tmpDir, 'single.js'), '')
    const result = await globTool.execute({ pattern: '*.js' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('single.js')
  })
})

// ============================================================
// Grep Tool
// ============================================================

describe('Grep tool definition', () => {
  it('has correct metadata', () => {
    expect(grepTool.name).toBe('Grep')
    expect(grepTool.category).toBe('file')
    expect(grepTool.permission).toBe('auto')
  })

  it('requires pattern parameter', () => {
    const params = grepTool.parameters as { required: string[] }
    expect(params.required).toEqual(['pattern'])
  })

  it('has include as optional parameter', () => {
    const params = grepTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('include')
  })
})

describe('Grep tool execution', () => {
  beforeEach(() => {
    mockRealSpawn()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('finds pattern in files', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world\nfoo bar\nhello again')
    const result = await grepTool.execute({ pattern: 'hello', path: tmpDir }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('hello')
  })

  it('returns (no matches) when pattern not found', async () => {
    writeFileSync(join(tmpDir, 'empty.txt'), 'nothing here')
    const result = await grepTool.execute({ pattern: 'ZZZZZNOTEXIST', path: tmpDir }, ctx)
    expect(result.success).toBe(true)
  })

  it('searches with include filter', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'export const x = 1')
    writeFileSync(join(tmpDir, 'b.txt'), 'export const x = 1')
    const result = await grepTool.execute({ pattern: 'export', path: tmpDir, include: '*.ts' }, ctx)
    expect(result.success).toBe(true)
    // Should find in .ts but exclude .txt
    expect(result.content).toContain('a.ts')
    expect(result.content).not.toContain('b.txt')
  })
})

describe('Grep tool timeout (stall guard)', () => {
  beforeEach(() => {
    mockRealSpawn()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('kills a hanging search instead of blocking forever', async () => {
    // `sleep 5` outlives a 100ms timeout → runSearch must kill it and report timedOut.
    const t0 = Date.now()
    const { timedOut } = await runSearch(['sleep', '5'], tmpDir, 100)
    expect(timedOut).toBe(true)
    // Returned promptly (~100ms), not after the full 5s sleep.
    expect(Date.now() - t0).toBeLessThan(4000)
  })
})
