import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadPlugins } from '../../src/plugin/plugin-loader'
import { HookEngine } from '../../src/core/hooks'
import type { PluginManager } from '../../src/plugin/plugin-manager'
import { McpClient } from '../../src/mcp/client'
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

describe('loadPlugins — removing a plugin removes only its own hooks', () => {
  /**
   * Build a plugin whose one hook writes a line to `marker` when it runs, load it,
   * and hand back the engine plus a function that runs the removal callback.
   *
   * The hook is observed by what it *does* rather than by what the engine holds,
   * so "it did not run" cannot be confused with "it was never registered".
   */
  function withHookPlugin(): {
    engine: HookEngine
    remove: () => void
    marker: string
    mine: () => number
  } {
    const dir = join(ROOT, `h-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(dir, { recursive: true })
    const marker = join(dir, 'ran.txt')
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'hook-plugin',
        version: '1.0.0',
        hooks: [
          {
            type: 'command',
            event: 'SessionStart',
            command: 'sh',
            args: ['-c', `echo x >> ${marker}`],
          },
        ],
      }),
      'utf-8',
    )

    const engine = new HookEngine()
    let mine = 0
    engine.register({
      event: 'SessionStart',
      handler: async () => {
        mine++
        return { allowed: true }
      },
    })

    const removals = new Map<string, () => void>()
    loadPlugins(
      {
        getEnabled: () => [{ name: 'hook-plugin', path: dir, enabled: true }],
        onRemove: (name: string, cb: () => void) => void removals.set(name, cb),
      } as unknown as PluginManager,
      {} as never,
      {} as never,
      engine,
      { connect: async () => {}, disconnect: () => [] } as unknown as McpClient,
      new Map(),
    )

    // Tripwire on the premise: the marker must appear *because* the hook ran, so
    // nothing before the event may have created it.
    expect(existsSync(marker)).toBe(false)

    return { engine, remove: () => removals.get('hook-plugin')!(), marker, mine: () => mine }
  }

  const hookLines = (marker: string): number =>
    existsSync(marker) ? readFileSync(marker, 'utf-8').trim().split('\n').filter(Boolean).length : 0

  it('runs the plugin’s hook while the plugin is installed', async () => {
    const { engine, marker } = withHookPlugin()
    await engine.executeSessionStart('s')
    expect(hookLines(marker)).toBe(1)
  })

  it('leaves another source’s hooks registered', async () => {
    // The cleanup ran `hookEngine.unregister(event)`, which removes every hook on
    // that event — the operator's own `settings.json` hooks and other plugins'
    // included. Removing plugin A silently disabled hooks that had nothing to do
    // with it, and nothing anywhere said so.
    const { engine, remove, marker, mine } = withHookPlugin()

    remove()
    await engine.executeSessionStart('s')

    expect(mine()).toBe(1)
    // The plugin's own hook is gone. Without this half, "the other hook still runs"
    // would be satisfied by a cleanup that removed nothing at all.
    expect(hookLines(marker)).toBe(0)
  })
})

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

// ============================================================
// 卸载插件时，它带来的 MCP 工具必须**真的**从注册表里走掉。
//
// 注册走的是 `convertMcpTool` → `mcp__<sanitizeName(server)>__<tool>`：服务器名要
// 先**小写化、非 `[a-z0-9-]` 换 `_`**。卸载时若按原始名拼 `mcp__My Server__echo` 去删，
// 一个都命中不了 —— 而 `Map.delete` 删不到东西**也不报错**，于是插件卸载后它的工具
// 继续挂在模型面前，调用时才炸。这一格钉的是「删用的是注册那一把尺」。
//
// ⚠️ `registerMcpServerTools` 取的是 `McpClient.getInstance()` 这个**单例**，不用
// loader 手里那个 `mcpClient`（后者只走 `connect` / `disconnect`）—— 所以工具要从单例上
// 造，别从传进 `loadPlugins` 的替身上造（那样 `getTools` 返回空，注册数是 0）。
// ============================================================

describe('loadPlugins — 卸载时按注册时的（已净化的）键把 MCP 工具撤掉', () => {
  /** 声明了一个 MCP 服务器的插件目录；服务器名刻意带空格和大写。 */
  const SERVER_RAW = 'My Server'

  afterEach(async () => {
    vi.restoreAllMocks()
    await McpClient.getInstance().closeAll()
    McpClient.resetInstance()
  })

  function withMcpPlugin(): {
    toolsMap: Map<string, never>
    remove: () => void
  } {
    const dir = makePluginDir({ name: SERVER_RAW, command: 'mcp-thing' })
    const removals = new Map<string, () => void>()
    const toolsMap = new Map<string, never>()
    const mcpClient = {
      connect: async () => {},
      disconnect: () => ['echo', 'add'],
    } as unknown as McpClient

    vi.spyOn(McpClient.getInstance(), 'getTools').mockReturnValue([
      { name: 'echo', description: 'e', inputSchema: { type: 'object', properties: {} } },
      { name: 'add', description: 'a', inputSchema: { type: 'object', properties: {} } },
    ] as never)

    loadPlugins(
      {
        getEnabled: () => [{ name: 'mcp-plugin', path: dir, enabled: true }],
        onRemove: (name: string, cb: () => void) => void removals.set(name, cb),
      } as unknown as PluginManager,
      {} as never,
      {} as never,
      { register: () => {}, unregister: () => {} } as never,
      mcpClient,
      toolsMap as never,
    )

    return { toolsMap, remove: () => removals.get('mcp-plugin')!() }
  }

  it('注册进来的是净化后的键，卸载后一个不剩', async () => {
    const { toolsMap, remove } = withMcpPlugin()
    // 前提：注册确实发生过，且**确实**净了名。少了这半，下面 `size === 0`
    // 可能只是「压根没注册过」。
    await Promise.resolve()
    await Promise.resolve()
    expect([...toolsMap.keys()].sort()).toEqual(['mcp__my_server__add', 'mcp__my_server__echo'])

    remove()

    expect(toolsMap.size).toBe(0)
  })

  it('反方向：别家服务器的工具不受牵连', async () => {
    const { toolsMap, remove } = withMcpPlugin()
    await Promise.resolve()
    await Promise.resolve()
    toolsMap.set('mcp__other__echo' as never, {} as never)

    remove()

    expect(toolsMap.has('mcp__other__echo' as never)).toBe(true)
  })
})
