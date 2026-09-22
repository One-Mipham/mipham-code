import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import type { ToolContext, CredentialMaskingConfig } from '../../src/shared'
import { Context } from '../../src/vajra'
import { collectTools } from '../../src/tools/seam'
import { createReadTool, readToolService } from '../../src/tools/file/read'
import { writeTool } from '../../src/tools/file/write'
import { editTool } from '../../src/tools/file/edit'
import { createGlobTool } from '../../src/tools/file/glob'
import {
  createGrepTool,
  runSearch,
  truncateGrepOutput,
  isTopLevelScope,
} from '../../src/tools/file/grep'
import { CREDENTIAL_SENTINEL } from '../../src/core/credential-masker'

const readTool = createReadTool()
const globTool = createGlobTool()
const grepTool = createGrepTool()

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
      stdout: Readable.toWeb(child.stdout!) as unknown as ReadableStream,
      stderr: Readable.toWeb(child.stderr!) as unknown as ReadableStream,
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
    expect(readTool.permission).toBe('self')
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

// ============================================================
// 大文件：offset/limit 必须真的能起作用。
//
// 原实现把整个文件读进内存之后**才**取 offset/limit，文件超过 50 MB 时直接回
// `File too large … Use offset/limit for large files.` —— 这条建议不可执行：
// 带上 offset/limit 重发，走进的是同一个分支、拿到的是同一句话。另一半是
// `content.split('\n')`：为了返回 limit 行，它给**整个文件**的每一行都建了一个
// JS 字符串。
//
// 下面用稀疏文件造「60 MB 的文件」：头部写真实内容，其余 truncate 撑长度，
// 磁盘上并不真落 60 MB。
// ============================================================

describe('Read tool — 大文件与行窗口', () => {
  /** 头部写真实内容，其余 truncate 成稀疏空洞。 */
  function sparseFile(name: string, head: string, size: number): string {
    const p = join(tmpDir, name)
    writeFileSync(p, head)
    truncateSync(p, size)
    return p
  }

  /** 行窗口的期望呈现：`     3\ttext`。测试里独立写一遍，当作格式的地面真值。 */
  function expectWindow(lines: string[], offset: number): string {
    return lines.map((l, i) => `${String(offset + i + 1).padStart(6, ' ')}\t${l}`).join('\n')
  }

  it('超过 50 MB 的文件也能取到头部若干行', async () => {
    const p = sparseFile('huge.log', 'alpha\nbeta\ngamma\n', 60_000_000)
    const result = await readTool.execute({ file_path: p, offset: 0, limit: 3 }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toBe(expectWindow(['alpha', 'beta', 'gamma'], 0))
  })

  it('整行都没有的 60 MB 文件按扫描上限报错，而不是把它整个读进内存', async () => {
    const p = sparseFile('blob.json', '{"a":1', 60_000_000)
    const result = await readTool.execute({ file_path: p }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/too large/i)
  })

  it('窗口跨 64 KiB 读块边界时多字节字符不被截断', async () => {
    // 每行 101 个「中」(303 B) + '\n' = 304 B ⇒ 第 65536 字节落在某个字符中间：
    // 65_536 = 215·304 + 176，而 176 不是 3 的倍数 —— 字符占 65534–65536。
    const line = '中'.repeat(101)
    const lines = Array.from({ length: 300 }, () => line)
    const p = join(tmpDir, 'wide.txt')
    writeFileSync(p, lines.join('\n') + '\n')

    // ① 整窗（> 64 KiB，必须跨过那个边界）
    const whole = await readTool.execute({ file_path: p, offset: 0, limit: 300 }, ctx)
    expect(whole.success).toBe(true)
    expect(whole.content).toBe(expectWindow(lines, 0))

    // ② 窗口起点落在第二个读块里（扫描要数完第一块中的所有换行）
    const mid = await readTool.execute({ file_path: p, offset: 215, limit: 3 }, ctx)
    expect(mid.success).toBe(true)
    expect(mid.content).toBe(expectWindow([line, line, line], 215))
  })

  it('凭据掩码路径与直读路径对同一窗口给出逐字相同的结果', async () => {
    // passthrough 规则：路径命中该文件，但提取模式什么都不匹配 ⇒ 内容原样返回。
    // 两条路径于是只差「行窗口从哪儿切」，输出必须逐字相同 —— 掩码那条走的是
    // 整串内容，直读那条走的是 fd，两条路对不上就是窗口实现分叉。
    const cases: Array<[number, number]> = [
      [0, 5],
      [1, 2],
      [2, 5],
      [9, 3],
    ]
    const fixtures = [
      { name: 'empty.txt', text: '' },
      { name: 'one.txt', text: 'only' },
      { name: 'trailing.txt', text: 'a\nb\n' },
      { name: 'plain.txt', text: 'a\nb\nc\nd\ne' },
      { name: 'wide.txt', text: `${'中'.repeat(101)}\n${'文'.repeat(101)}\n` },
    ]
    const config = (files: CredentialMaskingConfig['files']): CredentialMaskingConfig => ({
      enabled: true,
      files,
      output_scrubbing: { enabled: false, patterns: [] },
      env_filter: { enabled: false, patterns: [] },
    })

    for (const f of fixtures) {
      const p = join(tmpDir, f.name)
      writeFileSync(p, f.text)
      // 规则匹配的是**解析后**的路径（resolveSafe 会 realpath：macOS 上
      // /var/folders/… → /private/var/folders/…），所以规则也得写 realpath ——
      // 否则规则不命中，下面比的就成了直读路径跟它自己。
      const realPath = realpathSync(p)
      const maskedTool = createReadTool(
        config([
          {
            path: realPath,
            mode: 'extract',
            extract: [{ pattern: 'ZZZ_NEVER_MATCHES_ZZZ' }],
            onExtractNoMatch: 'passthrough',
          },
        ]),
      )
      // 正对照：同一条路径换成 full 规则必须拿到哨兵 —— 这一条才证明「掩码那条路
      // 真的被走到了」，等价断言才有意义。
      const sentinelTool = createReadTool(config([{ path: realPath, mode: 'full' }]))

      for (const [offset, limit] of cases) {
        const expected = expectWindow(f.text.split('\n').slice(offset, offset + limit), offset)
        const plain = await readTool.execute({ file_path: p, offset, limit }, ctx)
        const masked = await maskedTool.execute({ file_path: p, offset, limit }, ctx)
        const sentinel = await sentinelTool.execute({ file_path: p, offset, limit }, ctx)
        expect(plain.success).toBe(true)
        expect(plain.content).toBe(expected)
        expect(sentinel.content).toBe(CREDENTIAL_SENTINEL)
        expect(masked.content).toBe(expected)
      }
    }
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
// Symlink escape protection (resolveSafe + O_NOFOLLOW chain)
// ============================================================

describe('symlink escape protection', () => {
  let outside: string

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'mipham-outside-'))
  })

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true })
  })

  it('Read rejects a symlink pointing outside the workspace', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'top-secret')
    symlinkSync(join(outside, 'secret.txt'), join(tmpDir, 'link.txt'))
    await expect(readTool.execute({ file_path: join(tmpDir, 'link.txt') }, ctx)).rejects.toThrow(
      /outside|protected/,
    )
  })

  it('Write rejects a symlink pointing outside the workspace (target untouched)', async () => {
    writeFileSync(join(outside, 'victim.txt'), 'original')
    symlinkSync(join(outside, 'victim.txt'), join(tmpDir, 'link.txt'))
    await expect(
      writeTool.execute({ file_path: join(tmpDir, 'link.txt'), content: 'pwned' }, ctx),
    ).rejects.toThrow(/outside|protected/)
    expect(readFileSync(join(outside, 'victim.txt'), 'utf-8')).toBe('original')
  })

  it('Edit rejects a symlink pointing outside the workspace (target untouched)', async () => {
    writeFileSync(join(outside, 'victim.txt'), 'hello world')
    symlinkSync(join(outside, 'victim.txt'), join(tmpDir, 'link.txt'))
    await expect(
      editTool.execute(
        { file_path: join(tmpDir, 'link.txt'), old_string: 'hello', new_string: 'pwned' },
        ctx,
      ),
    ).rejects.toThrow(/outside|protected/)
    expect(readFileSync(join(outside, 'victim.txt'), 'utf-8')).toBe('hello world')
  })
})

// ============================================================
// Glob Tool
// ============================================================

describe('Glob tool definition', () => {
  it('has correct metadata', () => {
    expect(globTool.name).toBe('Glob')
    expect(globTool.category).toBe('file')
    expect(globTool.permission).toBe('self')
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

  it('marks the 500-match cap as truncated instead of dropping matches silently', async () => {
    // 505 个匹配 ⇒ 必然撞上限。截断本身不是缺陷，**不告知**才是：模型会把
    // 「只看到 500 条」当成「一共就 500 条」，而同一份代码里 Grep 特意加了
    // `(truncated)` 标记。判据 = 既看到 500 条正文、也看到被截的说明。
    for (let i = 0; i < 505; i++) writeFileSync(join(tmpDir, `f${i}.txt`), '')
    const result = await globTool.execute({ pattern: '*.txt', path: tmpDir }, ctx)
    expect(result.success).toBe(true)
    expect(result.content.split('\n').filter((line) => line.endsWith('.txt'))).toHaveLength(500)
    expect(result.content).toContain('(truncated')
  })

  it('does not claim truncation when every match fits', async () => {
    // 反方向：小结果集不得出现标记 —— 一条永远为真的提示等于没有提示。
    writeFileSync(join(tmpDir, 'only.txt'), '')
    const result = await globTool.execute({ pattern: '*.txt', path: tmpDir }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).not.toContain('(truncated')
  })
})

// ============================================================
// Grep Tool
// ============================================================

describe('Grep tool definition', () => {
  it('has correct metadata', () => {
    expect(grepTool.name).toBe('Grep')
    expect(grepTool.category).toBe('file')
    expect(grepTool.permission).toBe('self')
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

describe('Grep fallback (find -type f) symlink safety', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not follow symlinks when rg is unavailable', async () => {
    // Force ripgrep to be "unavailable" (Bun.spawn throws ENOENT) so the
    // find-based fallback runs; run the real `find` command for the fallback.
    vi.spyOn(Bun, 'spawn').mockImplementation((cmd: string[], opts?: { cwd?: string }) => {
      if (cmd[0] === 'rg') {
        throw Object.assign(new Error('Executable not found in $PATH: "rg"'), { code: 'ENOENT' })
      }
      const child = spawn(cmd[0]!, cmd.slice(1), {
        cwd: opts?.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const exited = new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? 0))
      })
      return {
        stdout: Readable.toWeb(child.stdout!) as unknown as ReadableStream,
        stderr: Readable.toWeb(child.stderr!) as unknown as ReadableStream,
        exited,
        get exitCode() {
          return child.exitCode
        },
        kill: () => child.kill(),
      } as any
    })

    const outside = mkdtempSync(join(tmpdir(), 'mipham-grep-outside-'))
    try {
      writeFileSync(join(tmpDir, 'inside.txt'), 'NEEDLE inside')
      writeFileSync(join(outside, 'secret.txt'), 'NEEDLE outside-secret')
      symlinkSync(join(outside, 'secret.txt'), join(tmpDir, 'leak-link.txt'))

      const result = await grepTool.execute({ pattern: 'NEEDLE', path: tmpDir }, ctx)
      expect(result.success).toBe(true)
      expect(result.content).toContain('inside.txt')
      // The symlink to an out-of-workspace file must not be followed.
      expect(result.content).not.toContain('outside-secret')
      expect(result.content).not.toContain('secret.txt')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('Grep top-level scope guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('flags the home directory and filesystem root', () => {
    expect(isTopLevelScope('/Users/me', '/Users/me')).toBe(true)
    expect(isTopLevelScope('/', '/Users/me')).toBe(true)
  })

  it('does not flag a normal project directory', () => {
    expect(isTopLevelScope('/Users/me/code/my-project', '/Users/me')).toBe(false)
  })

  it('fails fast when searching from a top-level directory without a path', async () => {
    // The guard must return before any spawn — a spawn here would mean the guard
    // failed and we started scanning a huge tree. Use filesystem root `/` (always
    // exists and is canonical) since homedir() is mocked to a non-existent path.
    vi.spyOn(Bun, 'spawn').mockImplementation((cmd: string[]) => {
      throw new Error(`unexpected spawn of ${cmd[0]} — scope guard must fail before spawning`)
    })
    const result = await grepTool.execute({ pattern: 'needle' }, { ...ctx, cwd: '/' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Specify a project directory')
  })
})

describe('Grep rg exit 2 (error) does not fall back to find', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a narrow-scope error instead of stalling the find fallback', async () => {
    // rg exits 2 with empty stdout (permission denied) — must NOT run the
    // slow `find` fallback (which would spawn a real find over cwd).
    // 这里原先给 stdout 与 stderr 传的是**同一个**流对象；bun 从不这样返回，
    // 而 runSearch 现在两条管道并发读，同一个流读两次会抛（流被锁）。
    // 换成 fakeProc：两个独立的流，与真实形状一致。
    vi.spyOn(Bun, 'spawn').mockImplementation((cmd: string[]) => {
      if (cmd[0] === 'rg') return fakeProc('', '', 2)
      throw new Error(`unexpected spawn of ${cmd[0]} — find fallback must not run`)
    })

    const result = await grepTool.execute({ pattern: 'needle', path: tmpDir }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('rg error (exit 2)')
  })
})

describe('Grep error attribution (rg 起不来 ≠ rg 没装)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names the real cause when rg fails to start for a reason other than ENOENT', async () => {
    // rg 装了却起不来（资源耗尽之类）时，回退到 find 只会换来第二个失败，
    // 而错误信息里的「装 ripgrep 就好了」会把排查方向整条带偏。
    vi.spyOn(Bun, 'spawn').mockImplementation((cmd: string[]) => {
      if (cmd[0] === 'rg') throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' })
      throw new Error(`unexpected spawn of ${cmd[0]} — 非 ENOENT 失败不得回退到 find`)
    })

    const result = await grepTool.execute({ pattern: 'needle', path: tmpDir }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('EAGAIN')
    expect(result.error).not.toContain('Install ripgrep')
  })

  it('names the real cause when the find fallback itself cannot start', async () => {
    // rg 确实不在 PATH（ENOENT）⇒ 走回退；回退也起不来时，报的是**回退**的
    // 真实原因，而不是一句「去装 ripgrep」（那时 ripgrep 根本不是问题所在）。
    vi.spyOn(Bun, 'spawn').mockImplementation((cmd: string[]) => {
      if (cmd[0] === 'rg')
        throw Object.assign(new Error('Executable not found'), { code: 'ENOENT' })
      throw new Error('EMFILE: too many open files')
    })

    const result = await grepTool.execute({ pattern: 'needle', path: tmpDir }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('EMFILE')
    expect(result.error).not.toContain('Install ripgrep')
  })
})

describe('truncateGrepOutput', () => {
  it('leaves short output unchanged', () => {
    expect(truncateGrepOutput('short\noutput')).toBe('short\noutput')
  })

  it('returns (no matches) for empty output', () => {
    expect(truncateGrepOutput('')).toBe('(no matches)')
  })

  it('marks oversized output as truncated and caps it', () => {
    const big = 'x'.repeat(60_000)
    const out = truncateGrepOutput(big)
    expect(out).toContain('(truncated)')
    expect(out.length).toBeLessThan(60_000)
    expect(out.startsWith('x'.repeat(50_000))).toBe(true)
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

// ============================================================
// Phase 2 — 输出上限与错误分类
//
// 两条搜索路径（rg 快路径 / find 回退）此前在同一个函数里被区别对待：
// 只有回退那条截断、只有回退那条把退出码 1 当「无匹配」，而两条路径的
// stderr 都没人读。下面把三件事分别在**两条路径**上钉住。
// ============================================================

/** 造一个假的 spawn 结果；stdout / stderr 必须是**两个**流（bun 从不同一个）。 */
function fakeProc(stdoutText: string, stderrText: string, exitCode: number) {
  // 必须是 Buffer 块：`Readable.from(['str'])` 产出的是字符串块，
  // `new Response(stream)` 只认 Uint8Array，读的时候抛 "Received non-Uint8Array chunk"。
  const stream = (s: string) =>
    Readable.toWeb(Readable.from(s ? [Buffer.from(s)] : [])) as unknown as ReadableStream
  return {
    stdout: stream(stdoutText),
    stderr: stream(stderrText),
    exited: Promise.resolve(exitCode),
    get exitCode() {
      return exitCode
    },
    kill: () => {},
  } as any
}

describe('Grep rg 快路径也走上限', () => {
  beforeEach(mockRealSpawn)
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const HUGE = 'x'.repeat(60_000)

  it('rg exit 0 的超限输出被截断并加标记', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation((cmd: string[]) => {
      if (cmd[0] === 'rg') return fakeProc(HUGE, '', 0)
      throw new Error(`unexpected spawn of ${cmd[0]} — rg 成功时不该走 find 回退`)
    })
    const r = await grepTool.execute({ pattern: 'needle', path: tmpDir }, ctx)
    expect(r.success).toBe(true)
    expect(r.content).toContain('(truncated)')
    expect(r.content.length).toBeLessThan(60_000)
  })

  it('rg exit 2 的部分结果被截断，但注解不被截断吃掉', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation((cmd: string[]) => {
      if (cmd[0] === 'rg') return fakeProc(HUGE, '', 2)
      throw new Error(`unexpected spawn of ${cmd[0]} — exit 2 不该走 find 回退`)
    })
    const r = await grepTool.execute({ pattern: 'needle', path: tmpDir }, ctx)
    expect(r.success).toBe(true)
    expect(r.content).toContain('(truncated)')
    // 注解是我们自己加的，必须留在截断之外，否则模型看到的是一句被劈开的提示
    expect(r.content).toContain('rg exited 2')
  })
})

describe('Grep find 回退不再把「出错」读成「无匹配」', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** rg 不可用 ⇒ 落回 find；find 按给定读数返回。 */
  function mockFindOnly(stdoutText: string, stderrText: string, exitCode: number) {
    vi.spyOn(Bun, 'spawn').mockImplementation((cmd: string[]) => {
      if (cmd[0] === 'rg') {
        throw Object.assign(new Error('Executable not found in $PATH: "rg"'), { code: 'ENOENT' })
      }
      if (cmd[0] === 'find') return fakeProc(stdoutText, stderrText, exitCode)
      throw new Error(`unexpected spawn of ${cmd[0]}`)
    })
  }

  it('退出码 1 且 stderr 非空 ⇒ 报错，不报「无匹配」', async () => {
    mockFindOnly('', 'find: grep: No such file or directory', 1)
    const r = await grepTool.execute({ pattern: 'needle', path: tmpDir }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('No such file or directory')
    expect(r.content).not.toBe('(no matches)')
  })

  it('正对照：退出码 1 且 stderr 为空 ⇒ 仍然报「无匹配」', async () => {
    // 没有这条，「把 exit 1 一律改成报错」也能让上一条变绿 —— 那会把
    // 真正的「搜索无结果」变成错误，是同一个 bug 的镜像。
    mockFindOnly('', '', 1)
    const r = await grepTool.execute({ pattern: 'needle', path: tmpDir }, ctx)
    expect(r.success).toBe(true)
    expect(r.content).toBe('(no matches)')
  })
})

describe('runSearch 消费 stderr', () => {
  beforeEach(mockRealSpawn)
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('回传 stderr 的内容', async () => {
    const { stdout, stderr } = await runSearch(
      [process.execPath, '-e', 'console.log("out"); process.stderr.write("err")'],
      tmpDir,
      10_000,
    )
    expect(stdout.trim()).toBe('out')
    expect(stderr).toBe('err')
  })

  it('stderr 超过管道缓冲也不卡死', async () => {
    // 300 KB 远超 ~64 KB 的管道缓冲：不并发读 stderr 的话，子进程会在写
    // stderr 时阻塞、永不退出，于是 stdout 也永远读不完 —— 只能等超时。
    const { timedOut, stdout, stderr } = await runSearch(
      [process.execPath, '-e', 'process.stderr.write("x".repeat(300000)); console.log("out")'],
      tmpDir,
      5_000,
    )
    expect(timedOut).toBe(false)
    expect(stdout.trim()).toBe('out')
    expect(stderr.length).toBe(300_000)
  })
})
