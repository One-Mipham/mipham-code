import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Isolate this file from the real ~/.mipham. The config tool resolves its store
// from os.homedir(), and this file used to rmSync() the user's live config.yml
// (and write theme / editor.fontSize into it) on every run. Same approach as
// test/config/loader-restore.test.ts.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-network-system`,
  }
})

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import type { ToolContext } from '../../src/shared'
import { webFetchTool } from '../../src/tools/network/web-fetch'
import { PACKAGE_VERSION } from '../../src/shared/package-info'
import { webSearchTool } from '../../src/tools/network/web-search'
import { createConfigTool } from '../../src/tools/system/config'
import { mcpTool } from '../../src/tools/system/mcp'
import { ENC_PREFIX, decryptApiKey, getCredentialKey } from '../../src/config/credential-crypto'
import { CREDENTIAL_SENTINEL } from '../../src/core/credential-masker'

const configTool = createConfigTool()

// ── Test context ──

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

// ============================================================
// WebFetch Tool
// ============================================================

describe('WebFetch tool definition', () => {
  it('has correct metadata', () => {
    expect(webFetchTool.name).toBe('WebFetch')
    expect(webFetchTool.category).toBe('network')
    expect(webFetchTool.permission).toBe('self')
  })

  it('requires url parameter', () => {
    const params = webFetchTool.parameters as { required: string[] }
    expect(params.required).toEqual(['url'])
  })

  it('has optional prompt parameter', () => {
    const params = webFetchTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('prompt')
    expect(params.properties).toHaveProperty('url')
  })
})

describe('WebFetch tool execution', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches URL and converts HTML to markdown', async () => {
    const mockHtml = '<html><body><h1>Hello</h1><p>World</p></body></html>'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'text/html']]),
    }) as unknown as typeof fetch

    const result = await webFetchTool.execute({ url: 'https://md-test.example.com' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('Hello')
    expect(result.content).toContain('World')
    // HTML tags should be converted to markdown (h1 → # heading)
    expect(result.content).not.toContain('<h1>')
  })

  it('sends User-Agent header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('plain text'),
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'text/plain']]),
    }) as unknown as typeof fetch

    await webFetchTool.execute({ url: 'https://user-agent-test.example.com' }, ctx)
    const callArgs = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(callArgs[0]).toBe('https://user-agent-test.example.com')
    // 版本号必须**取自包元数据**，不是字面量：字面量会随发版各漂各的，而
    // `toContain('Mipham-Code')` 对「写死的旧版本」一样绿（它曾经就是写死的）。
    expect(callArgs[1]?.headers?.['User-Agent']).toBe(`Mipham-Code/${PACKAGE_VERSION}`)
  })

  it('returns error for non-200 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Map([['content-type', 'text/html']]),
    }) as unknown as typeof fetch

    const result = await webFetchTool.execute(
      { url: 'https://error-test.example.com/missing' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 404')
  })

  it('handles fetch errors gracefully', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('Network error')) as unknown as typeof fetch

    const result = await webFetchTool.execute({ url: 'https://invalid.test' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Fetch failed')
    expect(result.error).toContain('web-access')
  })

  it('truncates long responses to 100K chars', async () => {
    const longText = '<p>' + 'x'.repeat(200_000) + '</p>'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(longText),
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'text/html']]),
    }) as unknown as typeof fetch

    const result = await webFetchTool.execute({ url: 'https://example.com/large' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(110_000) // 100K + header overhead
  })

  it('caches responses for subsequent requests', async () => {
    const mockHtml = '<html><body><p>cached content</p></body></html>'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'text/html']]),
    }) as unknown as typeof fetch

    await webFetchTool.execute({ url: 'https://example.com/cached' }, ctx)
    const firstCallCount = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length

    // Second call should hit cache (no additional fetch)
    await webFetchTool.execute({ url: 'https://example.com/cached' }, ctx)
    const secondCallCount = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length
    expect(secondCallCount).toBe(firstCallCount) // no new fetch call
  })

  it('upgrades HTTP to HTTPS', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('ok'),
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'text/plain']]),
    }) as unknown as typeof fetch

    await webFetchTool.execute({ url: 'http://http-upgrade-test.example.com' }, ctx)
    const callArgs = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(callArgs[0]).toBe('https://http-upgrade-test.example.com')
  })
})

// ============================================================
// WebSearch Tool
// ============================================================

describe('WebSearch tool definition', () => {
  it('has correct metadata', () => {
    expect(webSearchTool.name).toBe('WebSearch')
    expect(webSearchTool.category).toBe('network')
    expect(webSearchTool.permission).toBe('self')
  })

  it('requires query parameter', () => {
    const params = webSearchTool.parameters as { required: string[] }
    expect(params.required).toEqual(['query'])
  })

  it('has optional allowed_domains and blocked_domains', () => {
    const params = webSearchTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('allowed_domains')
    expect(params.properties).toHaveProperty('blocked_domains')
  })

  it('requires query to be at least 2 characters', () => {
    const params = webSearchTool.parameters as { properties: Record<string, unknown> }
    const query = params.properties.query as { minLength: number }
    expect(query.minLength).toBe(2)
  })
})

describe('WebSearch tool execution', () => {
  it('returns helpful setup message when API key not configured', async () => {
    const result = await webSearchTool.execute({ query: 'vitest tutorial' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('vitest tutorial')
    expect(result.content).toContain('not yet configured')
    expect(result.content).toContain('brave.com/search/api/')
    expect(result.content).toContain('web-access')
  })

  it('mentions Brave Search API setup instructions', async () => {
    const result = await webSearchTool.execute({ query: 'test' }, ctx)
    expect(result.content).toContain('BRAVE_API_KEY')
    expect(result.content).toContain('export')
  })

  it('passes query correctly to response', async () => {
    const result = await webSearchTool.execute({ query: 'TypeScript decorators' }, ctx)
    expect(result.content).toContain('TypeScript decorators')
  })
})

// ============================================================
// Config Tool
// ============================================================

describe('Config tool definition', () => {
  it('has correct metadata', () => {
    expect(configTool.name).toBe('Config')
    expect(configTool.category).toBe('system')
    expect(configTool.permission).toBe('ask')
  })

  it('requires action parameter', () => {
    const params = configTool.parameters as { required: string[] }
    expect(params.required).toEqual(['action'])
  })

  it('accepts action enum: get, set, list', () => {
    const params = configTool.parameters as { properties: Record<string, unknown> }
    const action = params.properties.action as { enum: string[] }
    expect(action.enum).toEqual(['get', 'set', 'list'])
  })

  it('has key and value parameters', () => {
    const params = configTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('key')
    expect(params.properties).toHaveProperty('value')
  })
})

describe('Config tool execution', () => {
  // The config tool resolves its store from os.homedir(), which the file-level
  // mock above redirects into a temp dir — this is NOT the user's ~/.mipham.
  const CONFIG_DIR = join(homedir(), '.mipham')

  function cleanConfig() {
    // Fail closed: never touch anything outside tmpdir. If the vi.mock above is
    // ever dropped, CONFIG_DIR would silently become the live config dir again.
    if (!CONFIG_DIR.startsWith(tmpdir())) {
      throw new Error(`refusing to clean ${CONFIG_DIR}: outside ${tmpdir()}`)
    }
    rmSync(CONFIG_DIR, { recursive: true, force: true })
  }

  beforeEach(() => {
    cleanConfig()
  })

  afterEach(() => {
    cleanConfig()
  })

  // config.yml 的写路径原先走裸 writeFileSync ⇒ 权限由 umask 决定（典型 0644）。
  // 同一份配置的另一个写者 saveProviderApiKey（loader.ts:673）用的是 0600 的原子写，
  // 于是 Config 工具会把这份文件悄悄放宽。写坏的方向同样是「静默变空」：整份
  // read-modify-write 被打断，下一次读到的就是半截 YAML。
  it('写 config.yml 是原子的，且权限落在 0o600', async () => {
    await configTool.execute({ action: 'set', key: 'theme', value: 'dark' }, ctx)

    const configFile = join(CONFIG_DIR, 'config.yml')
    expect(existsSync(configFile)).toBe(true) // 正控：目标文件确实写出来了
    expect(parseYaml(readFileSync(configFile, 'utf-8'))).toMatchObject({ theme: 'dark' })
    // 写到一半崩掉留下的临时文件不该留在配置目录里
    expect(readdirSync(CONFIG_DIR).filter((f) => f.includes('.tmp'))).toEqual([])
    expect(statSync(configFile).mode & 0o777).toBe(0o600)

    // 「原子」的直接证据：原地截断重写保持同一个 inode，写临时文件再 rename 才会换。
    const before = statSync(configFile).ino
    await configTool.execute({ action: 'set', key: 'theme', value: 'light' }, ctx)
    expect(parseYaml(readFileSync(configFile, 'utf-8'))).toMatchObject({ theme: 'light' })
    expect(statSync(configFile).ino).not.toBe(before)
  })

  it('lists empty config', async () => {
    const result = await configTool.execute({ action: 'list' }, ctx)
    expect(result.success).toBe(true)
    // Empty config might be 'null' (from YAML) or '(empty config)'
    expect(typeof result.content).toBe('string')
  })

  it('sets and gets a config value', async () => {
    await configTool.execute({ action: 'set', key: 'theme', value: 'dark' }, ctx)
    const result = await configTool.execute({ action: 'get', key: 'theme' }, ctx)
    expect(result.success).toBe(true)
    // JSON.stringify wraps in quotes
    expect(result.content).toContain('dark')
  })

  it('supports dot notation for nested config', async () => {
    await configTool.execute({ action: 'set', key: 'editor.fontSize', value: '14' }, ctx)
    const result = await configTool.execute({ action: 'get', key: 'editor.fontSize' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('14')
  })

  it('gets multiple levels of nesting', async () => {
    await configTool.execute({ action: 'set', key: 'a.b.c', value: 'deep' }, ctx)
    const result = await configTool.execute({ action: 'get', key: 'a.b.c' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('deep')
  })

  it('lists config after setting values', async () => {
    await configTool.execute({ action: 'set', key: 'name', value: 'Mipham' }, ctx)
    const result = await configTool.execute({ action: 'list' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('Mipham')
  })

  it('键不存在时返回失败，而不是一个看着像空对象的答案', async () => {
    // 旧行为：`JSON.stringify(undefined)` 给出的**不是字符串**而是 `undefined` 本身
    // （违反 `content: string`）—— 这一格原先断言的正是那个怪状。F1-1 把 `get` 的渲染
    // 换成 YAML（好让擦洗看得见键名），同一情形会渲染成 `{}`，比原来更糟 ⇒ 显式报错。
    const result = await configTool.execute({ action: 'get', key: 'nonexistent' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Key not found')
  })

  it('errors when key is missing for get', async () => {
    const result = await configTool.execute({ action: 'get' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('key is required')
  })

  it('errors when key is missing for set', async () => {
    const result = await configTool.execute({ action: 'set', value: 'something' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('key is required')
  })

  it('errors for unknown action (when key is provided)', async () => {
    const result = await configTool.execute({ action: 'delete', key: 'some-key' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown action')
  })

  it('overwrites existing config value', async () => {
    await configTool.execute({ action: 'set', key: 'version', value: '1.0' }, ctx)
    await configTool.execute({ action: 'set', key: 'version', value: '2.0' }, ctx)
    const result = await configTool.execute({ action: 'get', key: 'version' }, ctx)
    expect(result.content).toContain('2.0')
  })
})

// provider 的 apiKey 是凭据，而**读**侧早就把 `enc:v1:` 当成它的 at-rest 形态：
// `loadConfig` → `decryptProviderApiKeys` 与 `getProviderApiKey` 都先看前缀再解密。
// 写侧却有两条路 —— `saveProviderApiKey`（loader.ts，加密）与 Config 工具（不加密）
// —— 而它们写的是**同一份文件**。于是「密钥在盘上是密文」这条保证，取决于用户当初
// 从哪个写者进来；从 Config 工具进来的那份，密文保证**静默降级**为明文。
//
// 判据不是「值变了」（那是把实现细节当标准），而是**能按读路径读回来**：用同一个
// key 解密后与原文逐字相等。只断言「有 enc:v1: 前缀」会把「加成了另一把 key」和
// 「多套了一层」一起放过 —— 后者的表现是读回来仍是密文。
describe('Config tool — provider apiKey 落盘即加密', () => {
  const CONFIG_DIR = join(homedir(), '.mipham')
  const configFile = join(CONFIG_DIR, 'config.yml')

  function clean(): void {
    if (!CONFIG_DIR.startsWith(tmpdir())) {
      throw new Error(`refusing to clean ${CONFIG_DIR}: outside ${tmpdir()}`)
    }
    rmSync(CONFIG_DIR, { recursive: true, force: true })
  }

  const storedKey = (): string =>
    (parseYaml(readFileSync(configFile, 'utf-8')) as { providers: Array<{ apiKey: string }> })
      .providers[0]!.apiKey

  beforeEach(clean)
  afterEach(clean)

  it('写入即加密，且能按读路径解回原文', async () => {
    await configTool.execute(
      { action: 'set', key: 'providers.0.apiKey', value: 'sk-secret-123' },
      ctx,
    )
    const stored = storedKey()
    expect(stored.startsWith(ENC_PREFIX)).toBe(true)
    expect(stored).not.toContain('sk-secret-123') // 明文不在文件里
    // 正控：读路径用的同一个 helper 解得回来 ⇒ 落盘的是「同一把 key 的密文」。
    expect(decryptApiKey(stored, getCredentialKey(CONFIG_DIR))).toBe('sk-secret-123')
  })

  it('`${VAR}` 模板原样落盘 —— 不是秘密，加密会让 env 方案不再可读', async () => {
    await configTool.execute(
      { action: 'set', key: 'providers.0.apiKey', value: '${DEEPSEEK_API_KEY}' },
      ctx,
    )
    expect(storedKey()).toBe('${DEEPSEEK_API_KEY}')
  })

  it('已经是 enc:v1: 的值不再加密第二层（解回来仍是原文，不是密文）', async () => {
    // 幂等：`encryptApiKey` 自己不看前缀，所以这一格钉的是调用侧那道判断。
    // 套两层不会报错，只会让读侧解出一段密文 —— 静默，且那条路径的报错信息
    // 还会指向别处（`getProviderApiKey` 只在解密**抛错**时告警）。
    const already = ENC_PREFIX + 'not-a-real-payload'
    await configTool.execute({ action: 'set', key: 'providers.0.apiKey', value: already }, ctx)
    expect(storedKey()).toBe(already)
  })

  it('同一份文件里的非 apiKey 路径原样落盘（加密由路径决定，不是「凡 set 必加密」）', async () => {
    await configTool.execute(
      { action: 'set', key: 'providers.0.baseUrl', value: 'https://x.test' },
      ctx,
    )
    const doc = parseYaml(readFileSync(configFile, 'utf-8')) as {
      providers: Array<Record<string, string>>
    }
    expect(doc.providers[0]!.baseUrl).toBe('https://x.test')
  })

  it('`get` 回来的既不是明文、也不是密文：这条路径不再把凭据交回模型', async () => {
    // 读工具被 `resolveSafe` 的 Check 1 挡在工作目录内，读不到 ~/.mipham —— 所以
    // 「工具能不能拿到凭据」这个问题，答案由这一格决定。
    //
    // F1-2 立这一格时的边界是「不给明文、给落盘形态」；F1-1 把边界又推了一格：
    // 密文同样不交出去 —— 加密防的正是「这份文件被复制到别处」（`credential-crypto`
    // 的 C5 裁定），而模型上下文与随后的每一轮请求就是「别处」。
    await configTool.execute(
      { action: 'set', key: 'providers.0.apiKey', value: 'sk-secret-123' },
      ctx,
    )
    const result = await configTool.execute({ action: 'get', key: 'providers.0.apiKey' }, ctx)
    expect(result.content).not.toContain('sk-secret-123')
    expect(result.content).not.toContain(ENC_PREFIX)
    expect(result.content).toContain(CREDENTIAL_SENTINEL)
  })

  it('返回消息不把刚写入的密钥回显出来', async () => {
    const result = await configTool.execute(
      { action: 'set', key: 'providers.0.apiKey', value: 'sk-secret-123' },
      ctx,
    )
    expect(result.content).not.toContain('sk-secret-123')
    // 但必须说清它落在哪种形态 —— 否则用户打开 config.yml 看到密文会以为写坏了。
    expect(result.content).toContain('providers.0.apiKey')
    expect(result.content).toContain('encrypted')
  })
})

// ============================================================
// MCP Tool
// ============================================================

describe('MCP tool definition', () => {
  it('has correct metadata', () => {
    expect(mcpTool.name).toBe('MCP')
    expect(mcpTool.category).toBe('system')
    expect(mcpTool.permission).toBe('ask')
  })

  it('requires server and tool parameters', () => {
    const params = mcpTool.parameters as { required: string[] }
    expect(params.required).toEqual(['server', 'tool'])
  })

  it('has optional params parameter', () => {
    const params = mcpTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('params')
  })
})

describe('MCP tool execution', () => {
  it('returns error when server is not configured', async () => {
    const result = await mcpTool.execute({ server: 'nonexistent-server', tool: 'some-tool' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('not configured')
  })

  it('mentions .mipham/config.yml in error', async () => {
    const result = await mcpTool.execute({ server: 'test-server', tool: 'test-tool' }, ctx)
    expect(result.error).toContain('.mipham/config.yml')
  })

  it('requires server and tool parameters', async () => {
    const result = await mcpTool.execute({ server: 'unconfigured', tool: 'navigate' }, ctx)
    expect(result.success).toBe(false)
  })
})

// 定向安全审计 ③ 的 F1-1。这条工具是 `~/.mipham/config.yml` 的**读**侧，而那份文件
// 的用途之一就是放凭据：provider 的 apiKey（F1-2 之后盘上是 `enc:v1:` 密文）、MCP
// server 的 env / headers、inference hook 的 signing_secret。原来 `list` 返回
// `stringify(config)`、`get` 返回 `JSON.stringify(value)` —— 两份都是**原样**，于是
// 「读一眼配置」等于把整份凭据仓库送进模型上下文（落进会话日志，且随之后每一轮请求
// 发往提供商），而它此前是唯一一个把凭据仓库本体当输出吐出来、却不做任何擦洗的工具
// —— Read / Bash / Grep / Glob 四条的**输出**都过 `maskOutput`。
//
// 形状与那四条一致：工厂 + `inject: ['credentials']` 的 Service，擦洗复用同一个
// `maskOutput`（F1-2 的教训：不重写「什么算秘密」那份判断，它只有一处定义）。
// 与它们唯一的一处不同是**默认值的方向**：无参构造时取默认掩码策略，而不是「没有
// 就关掉」—— 这条工具的输出对象正是凭据仓库本身。
//
// 判据不是「值消失了」（那是把实现细节当标准），而是**机密不出现、非机密照常出现**：
// 只断言「不含密钥」的话，返回空串也能过。
describe('Config tool — 读路径不把凭据原样送出', () => {
  const CONFIG_DIR = join(homedir(), '.mipham')
  const configFile = join(CONFIG_DIR, 'config.yml')

  // 四种形态各一条：密文（F1-2 之后盘上的形态）、明文 apiKey（F1-2 之前的写者留下的
  // 那份）、下划线大写的 env 变量、以及名字里就写着 secret 的钩子密钥。
  const CIPHER_API_KEY = 'enc:v1:AAAAdeadbeefAAAA'
  const PLAIN_API_KEY = 'sk-live-FAKEFAKEFAKE1234'
  const MCP_TOKEN = 'ghp_FAKEFAKEFAKEFAKE123456'
  const HOOK_SECRET = 'shhh-fake-signing-secret'

  const FIXTURE = [
    'version: 0.85.8',
    'defaultProvider: deepseek',
    'theme: dark',
    'providers:',
    '  - id: deepseek',
    `    apiKey: ${CIPHER_API_KEY}`,
    '    model: deepseek-v4-pro',
    '  - id: openai',
    `    apiKey: ${PLAIN_API_KEY}`,
    'inference_hooks:',
    '  endpoint: https://hooks.example/v1',
    `  signing_secret: ${HOOK_SECRET}`,
    'skills:',
    '  mcpServers:',
    '    - name: gh',
    '      env:',
    `        GITHUB_TOKEN: ${MCP_TOKEN}`,
    '',
  ].join('\n')

  function writeFixture(): void {
    // 与同文件的 cleanConfig 同一条规矩：夹具写不出 tmpdir 就当场停下，
    // 否则这里会把真的用户配置覆盖掉。
    if (!CONFIG_DIR.startsWith(tmpdir())) {
      throw new Error(`refusing to write ${CONFIG_DIR}: outside ${tmpdir()}`)
    }
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(configFile, FIXTURE)
  }

  beforeEach(writeFixture)
  afterEach(() => {
    rmSync(CONFIG_DIR, { recursive: true, force: true })
  })

  it('list：机密一概不出现，非机密照常可读，且不碰盘上那份文件', async () => {
    const result = await configTool.execute({ action: 'list' }, ctx)
    expect(result.success).toBe(true)

    for (const secret of [CIPHER_API_KEY, PLAIN_API_KEY, MCP_TOKEN, HOOK_SECRET]) {
      expect(result.content).not.toContain(secret)
    }
    // 正控：机密是**被遮蔽**，不是整份输出被清空 —— 少了这一条，返回空串也能让上面四条过。
    expect(result.content).toContain(CREDENTIAL_SENTINEL)
    expect(result.content).toContain('deepseek')
    expect(result.content).toContain('dark')
    expect(readFileSync(configFile, 'utf-8')).toBe(FIXTURE)
  })

  it('get：取机密键 → 遮蔽；取非机密键 → 原样', async () => {
    const secret = await configTool.execute({ action: 'get', key: 'providers.0.apiKey' }, ctx)
    expect(secret.content).not.toContain(CIPHER_API_KEY)
    expect(secret.content).toContain(CREDENTIAL_SENTINEL)

    // 正控：非机密键必须逐字回得来。
    const plain = await configTool.execute({ action: 'get', key: 'theme' }, ctx)
    expect(plain.content).toContain('dark')
    expect(plain.content).not.toContain(CREDENTIAL_SENTINEL)

    // 值里带名字的那一支（MCP server 的 env 块）走同一条擦洗。
    const block = await configTool.execute({ action: 'get', key: 'skills.mcpServers' }, ctx)
    expect(block.content).not.toContain(MCP_TOKEN)

    expect(readFileSync(configFile, 'utf-8')).toBe(FIXTURE)
  })

  it('无 credentialConfig 时方向是「遮」不是「放」', async () => {
    const bare = createConfigTool()
    const result = await bare.execute({ action: 'list' }, ctx)
    expect(result.content).not.toContain(PLAIN_API_KEY)
    expect(result.content).toContain(CREDENTIAL_SENTINEL)
  })
})
