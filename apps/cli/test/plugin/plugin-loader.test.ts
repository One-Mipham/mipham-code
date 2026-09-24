import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadPlugins } from '../../src/plugin/plugin-loader'
import type { PluginManager } from '../../src/plugin/plugin-manager'
import type { McpClient } from '../../src/mcp/client'
import type { McpServerConfig } from '../../src/shared/index'

/**
 * A plugin's MCP declaration reaches the world only if `loadPlugins` calls
 * `connect` with it. The guard on that call used to require a `command`, so a
 * server declared by `url` alone — the ordinary shape for a remote server, and the
 * shape the Claude adapter already loads — was dropped with no message anywhere.
 */

const ROOT = join(tmpdir(), 'mipham-loader-test-' + process.pid)

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

function makePluginDir(cfg: Record<string, unknown>): string {
  const dir = join(ROOT, `p-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(dir, 'mcp-servers'), { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ name: dir.split('/').pop(), version: '1.0.0' }),
    'utf-8',
  )
  writeFileSync(join(dir, 'mcp-servers', 'server.json'), JSON.stringify(cfg), 'utf-8')
  return dir
}

async function loadWith(dir: string, stderr?: string[]): Promise<McpServerConfig[]> {
  const connected: McpServerConfig[] = []
  const pluginManager = {
    getEnabled: () => [{ name: 'p', path: dir, enabled: true }],
    onRemove: () => {},
  } as unknown as PluginManager
  const mcpClient = {
    connect: async (cfg: McpServerConfig) => {
      connected.push(cfg)
    },
    disconnect: () => [] as string[],
  } as unknown as McpClient

  const writes: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    loadPlugins(
      pluginManager,
      {} as never,
      {} as never,
      { register: () => {}, unregister: () => {} } as never,
      mcpClient,
      new Map(),
    )
    // `connect` is called from inside the loader's own promise chain.
    await Promise.resolve()
    await Promise.resolve()
  } finally {
    process.stderr.write = original
  }
  stderr?.push(...writes)
  return connected
}

describe('loadPlugins — MCP declarations reach the client', () => {
  it('connects a stdio server declared by command', async () => {
    const connected = await loadWith(
      makePluginDir({ name: 'local', command: 'node', args: ['s.js'] }),
    )

    expect(connected).toHaveLength(1)
    expect(connected[0]!.command).toBe('node')
  })

  it('connects a server declared by url alone', async () => {
    const connected = await loadWith(
      makePluginDir({ name: 'remote', url: 'https://example.com/mcp' }),
    )

    expect(connected).toHaveLength(1)
    expect(connected[0]!.url).toBe('https://example.com/mcp')
  })

  it('says why a server it cannot load was skipped, naming it', async () => {
    // The half that matters for a *broken* declaration: staying quiet is what made
    // the `url` case invisible for so long. A skipped server the operator is told
    // about is a diagnosis; one skipped in silence is a mystery.
    const stderr: string[] = []
    const connected = await loadWith(makePluginDir({ name: 'broken' }), stderr)

    expect(connected).toHaveLength(0)
    expect(stderr.join('\n')).toContain('broken')
  })
})
