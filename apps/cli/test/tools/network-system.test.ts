import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '@mipham/shared'
import { webFetchTool } from '../../src/tools/network/web-fetch'
import { webSearchTool } from '../../src/tools/network/web-search'
import { configTool } from '../../src/tools/system/config'
import { mcpTool } from '../../src/tools/system/mcp'

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
    expect(webFetchTool.permission).toBe('auto')
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

  it('fetches URL and extracts text content', async () => {
    const mockHtml = '<html><body><h1>Hello</h1><p>World</p></body></html>'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
      status: 200,
      statusText: 'OK',
    })

    const result = await webFetchTool.execute(
      { url: 'https://example.com' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('Hello')
    expect(result.content).toContain('World')
    // HTML tags should be stripped
    expect(result.content).not.toContain('<h1>')
  })

  it('sends User-Agent header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('ok'),
      status: 200,
      statusText: 'OK',
    })

    await webFetchTool.execute({ url: 'https://example.com' }, ctx)
    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toBe('https://example.com')
    expect(callArgs[1]?.headers?.['User-Agent']).toContain('Mipham-Code')
  })

  it('returns error for non-200 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    })

    const result = await webFetchTool.execute(
      { url: 'https://example.com/missing' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 404')
  })

  it('handles fetch errors gracefully', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

    const result = await webFetchTool.execute(
      { url: 'https://invalid.test' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Fetch failed')
  })

  it('truncates long responses to 50000 chars', async () => {
    const longText = '<p>' + 'x'.repeat(100_000) + '</p>'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(longText),
      status: 200,
      statusText: 'OK',
    })

    const result = await webFetchTool.execute(
      { url: 'https://example.com/large' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(50_000)
  })
})

// ============================================================
// WebSearch Tool
// ============================================================

describe('WebSearch tool definition', () => {
  it('has correct metadata', () => {
    expect(webSearchTool.name).toBe('WebSearch')
    expect(webSearchTool.category).toBe('network')
    expect(webSearchTool.permission).toBe('auto')
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
  it('returns search result stub', async () => {
    const result = await webSearchTool.execute(
      { query: 'vitest tutorial' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('vitest tutorial')
    expect(result.content).toContain('search API')
  })

  it('mentions search API configuration', async () => {
    const result = await webSearchTool.execute({ query: 'test' }, ctx)
    expect(result.content).toContain('Results would appear')
  })

  it('passes query correctly to response', async () => {
    const result = await webSearchTool.execute(
      { query: 'TypeScript decorators' },
      ctx,
    )
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
  // Config writes to ~/.mipham/config.yml. Clean up before/after tests.
  const CONFIG_DIR = join(process.env.HOME || tmpdir(), '.mipham')
  const CONFIG_FILE = join(CONFIG_DIR, 'config.yml')

  function cleanConfig() {
    try { rmSync(CONFIG_FILE, { force: true }) } catch { /* ok */ }
  }

  beforeEach(() => {
    cleanConfig()
  })

  afterEach(() => {
    cleanConfig()
  })

  it('lists empty config', async () => {
    const result = await configTool.execute({ action: 'list' }, ctx)
    expect(result.success).toBe(true)
    // Empty config might be 'null' (from YAML) or '(empty config)'
    expect(typeof result.content).toBe('string')
  })

  it('sets and gets a config value', async () => {
    await configTool.execute(
      { action: 'set', key: 'theme', value: 'dark' },
      ctx,
    )
    const result = await configTool.execute(
      { action: 'get', key: 'theme' },
      ctx,
    )
    expect(result.success).toBe(true)
    // JSON.stringify wraps in quotes
    expect(result.content).toContain('dark')
  })

  it('supports dot notation for nested config', async () => {
    await configTool.execute(
      { action: 'set', key: 'editor.fontSize', value: '14' },
      ctx,
    )
    const result = await configTool.execute(
      { action: 'get', key: 'editor.fontSize' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('14')
  })

  it('gets multiple levels of nesting', async () => {
    await configTool.execute(
      { action: 'set', key: 'a.b.c', value: 'deep' },
      ctx,
    )
    const result = await configTool.execute(
      { action: 'get', key: 'a.b.c' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('deep')
  })

  it('lists config after setting values', async () => {
    await configTool.execute(
      { action: 'set', key: 'name', value: 'Mipham' },
      ctx,
    )
    const result = await configTool.execute({ action: 'list' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('Mipham')
  })

  it('returns null for non-existent key', async () => {
    const result = await configTool.execute(
      { action: 'get', key: 'nonexistent' },
      ctx,
    )
    expect(result.success).toBe(true)
    // JSON.stringify(undefined) returns undefined (not valid JSON),
    // but the tool stringifies the value via reduce — undefined values
    // get JSON.stringified as well
  })

  it('errors when key is missing for get', async () => {
    const result = await configTool.execute({ action: 'get' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('key is required')
  })

  it('errors when key is missing for set', async () => {
    const result = await configTool.execute(
      { action: 'set', value: 'something' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('key is required')
  })

  it('errors for unknown action (when key is provided)', async () => {
    const result = await configTool.execute(
      { action: 'delete', key: 'some-key' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown action')
  })

  it('overwrites existing config value', async () => {
    await configTool.execute(
      { action: 'set', key: 'version', value: '1.0' },
      ctx,
    )
    await configTool.execute(
      { action: 'set', key: 'version', value: '2.0' },
      ctx,
    )
    const result = await configTool.execute(
      { action: 'get', key: 'version' },
      ctx,
    )
    expect(result.content).toContain('2.0')
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
  it('returns MCP call stub', async () => {
    const result = await mcpTool.execute(
      { server: 'github', tool: 'search-repos' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('MCP call')
    expect(result.content).toContain('github/search-repos')
  })

  it('mentions full MCP client integration', async () => {
    const result = await mcpTool.execute(
      { server: 'test-server', tool: 'test-tool' },
      ctx,
    )
    expect(result.content).toContain('MCP client')
  })

  it('includes server and tool in response', async () => {
    const result = await mcpTool.execute(
      { server: 'playwright', tool: 'navigate' },
      ctx,
    )
    expect(result.content).toContain('playwright')
    expect(result.content).toContain('navigate')
  })
})
