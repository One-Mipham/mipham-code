import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 无参路径（daemon 的 `createToolRegistry()`，见 `src/daemon/server.ts`）读的是
// **用户级** `~/.mipham/config.yml`。不把 homedir 挪开，测的就是开发机上的真实配置。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-registry` }
})

import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '../../src/vajra'
import type { ToolContext } from '../../src/shared'
import { createToolRegistry } from '../../src/tools/index'
import { collectTools } from '../../src/tools/seam'
import { DEFAULT_CREDENTIAL_MASKING_CONFIG } from '../../src/config/defaults'
import { CREDENTIAL_SENTINEL } from '../../src/core/credential-masker'

const ROOT = join(tmpdir(), 'mipham-test-registry')
const MIPHAM_HOME = join(ROOT, '.mipham')
const WORK = join(ROOT, 'work')

const toolCtx = { cwd: WORK, sessionId: 's', provider: 'p', model: 'm' } as ToolContext

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(MIPHAM_HOME, { recursive: true })
  mkdirSync(WORK, { recursive: true })
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('createToolRegistry (seam)', () => {
  it('returns all 31 built-in tools by default (incl. Read/Bash)', () => {
    const registry = createToolRegistry()
    expect(registry.has('Read')).toBe(true)
    expect(registry.has('Bash')).toBe(true)
    expect(registry.size).toBe(31)
  })

  it('mounts into a caller-provided context so plugins can add tools', () => {
    const ctx = new Context()
    ctx.provide('credentials', DEFAULT_CREDENTIAL_MASKING_CONFIG)
    createToolRegistry(ctx)
    // 挂一个插件工具，不改 tools/index.ts
    ctx.mount({
      apply(applyCtx) {
        applyCtx.provide('tool:CustomPluginTool', {
          name: 'CustomPluginTool',
          description: 'plugin',
          category: 'system',
          permission: 'self',
          parameters: {},
          execute: async () => ({ success: true, content: 'ok' }),
        })
      },
    })
    const tools = collectTools(ctx)
    expect(tools.has('CustomPluginTool')).toBe(true)
    expect(tools.has('Read')).toBe(true)
  })
})

// ============================================================
// 无参默认的凭据掩码 —— daemon 走的正是这条装配路径
// （`src/daemon/server.ts` 的 `sharedTools = createToolRegistry()`）。
//
// 原实现给这条路径提供 `DISABLED_CREDENTIAL_MASKING_CONFIG`，于是 daemon 里的
// Read/Bash/Grep/Glob **整套掩码都是关的**：子进程继承完整 `process.env`，
// 输出不擦洗，`~/.ssh/id_*` / `.env` 原样进对话。这不是「中立」——掩码是安全控制，
// 不配置就关掉是**fail-open**，方向和默认值恰好相反。
//
// 判据取**行为**：用无参注册表里的 Read 工具读一个文件，看有没有拿到哨兵。
// 前提是 defaultVajraContext 提供的配置**真的**被 Read 工具吃到了 —— 所以每条
// 「命中」都配一条「同样的读法、不在规则里的文件必须原样返回」作反方向对照。
// ============================================================
describe('无参默认（daemon 路径）的凭据掩码', () => {
  /** 用无参注册表里的 Read 工具读一个文件 —— 与 daemon 同一条装配路径。 */
  async function readViaDefaultRegistry(target: string) {
    const read = createToolRegistry().get('Read')
    expect(read, '无参注册表里没有 Read 工具').toBeDefined()
    return read!.execute({ file_path: target }, toolCtx)
  }

  it('默认规则就是开着的：.env 被掩码（fail-closed）', async () => {
    const envFile = join(WORK, '.env')
    writeFileSync(envFile, 'DEEPSEEK_API_KEY=sk-live-abcdef123456\n', 'utf-8')
    const plainFile = join(WORK, 'notes.txt')
    writeFileSync(plainFile, 'hello\n', 'utf-8')

    const masked = await readViaDefaultRegistry(envFile)
    expect(masked.success).toBe(true)
    expect(masked.content).toBe(CREDENTIAL_SENTINEL)

    // 反方向：同一个工具读一个普通文件必须原样返回 —— 否则上面那条可能只是
    // 「Read 坏了、什么都返回哨兵」。（带行号前缀，故取 toContain 而非全等。）
    const plain = await readViaDefaultRegistry(plainFile)
    expect(plain.content).toContain('hello')
    expect(plain.content).not.toBe(CREDENTIAL_SENTINEL)
  })

  it('吃用户级 config.yml 的 credential_masking 段', async () => {
    const secretFile = join(WORK, 'private-note.txt')
    writeFileSync(secretFile, 'note: token=abc123\n', 'utf-8')
    const otherFile = join(WORK, 'public-note.txt')
    writeFileSync(otherFile, 'note: nothing here\n', 'utf-8')

    // 规则匹配的是**解析后**的路径（macOS 上 /var → /private/var），所以写 realpath。
    writeFileSync(
      join(MIPHAM_HOME, 'config.yml'),
      `version: 1\ncredential_masking:\n  files:\n    - path: "${realpathSync(secretFile)}"\n      mode: full\n`,
      'utf-8',
    )

    const masked = await readViaDefaultRegistry(secretFile)
    expect(masked.content).toBe(CREDENTIAL_SENTINEL)

    // 反方向：这条规则是**从配置里读来的**，不是默认就有的 —— 不在规则里的文件
    // 必须原样返回（修前这里两条都是原样，因为整块掩码是关的）。
    const other = await readViaDefaultRegistry(otherFile)
    expect(other.content).toContain('nothing here')
  })
})
