import { describe, it, expect, afterEach, vi } from 'vitest'
import { McpClient } from '../../src/mcp/client'

describe('McpClient', () => {
  afterEach(async () => {
    await McpClient.getInstance().closeAll()
    McpClient.resetInstance()
  })

  describe('connect and disconnect', () => {
    it('connects to a mock MCP server', async () => {
      const client = McpClient.getInstance()
      await client.connect({
        name: 'mock',
        command: 'bun',
        args: ['run', 'test/mcp/mock-server.ts'],
      })

      const conn = client.getConnection('mock')
      expect(conn).toBeDefined()
      expect(conn!.status).toBe('connected')
      expect(conn!.serverInfo).toBeDefined()
    })

    it('discovers tools on connect', async () => {
      const client = McpClient.getInstance()
      await client.connect({
        name: 'mock',
        command: 'bun',
        args: ['run', 'test/mcp/mock-server.ts'],
      })

      const tools = client.getTools('mock')
      expect(tools).toHaveLength(2)
      expect(tools.map((t) => t.name)).toContain('echo')
      expect(tools.map((t) => t.name)).toContain('add')
    })

    it('disconnects a server', async () => {
      const client = McpClient.getInstance()
      await client.connect({
        name: 'mock',
        command: 'bun',
        args: ['run', 'test/mcp/mock-server.ts'],
      })

      client.disconnect('mock')
      expect(client.getConnection('mock')).toBeUndefined()
    })

    it('is a singleton across calls', () => {
      const a = McpClient.getInstance()
      const b = McpClient.getInstance()
      expect(a).toBe(b)
    })
  })

  describe('callTool', () => {
    it('calls a tool on a connected server', async () => {
      const client = McpClient.getInstance()
      await client.connect({
        name: 'mock',
        command: 'bun',
        args: ['run', 'test/mcp/mock-server.ts'],
      })

      const result = await client.callTool('mock', 'echo', { message: 'test' })
      expect(result.content[0]!.text).toContain('Echo: test')
      expect(result.isError).toBeFalsy()
    })

    it('returns error for unconnected server', async () => {
      const client = McpClient.getInstance()
      const result = await client.callTool('nonexistent', 'some-tool')
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('not connected')
    })
  })

  describe('multiple servers', () => {
    it('manages multiple connections', async () => {
      const client = McpClient.getInstance()

      await client.connect({
        name: 'server-a',
        command: 'bun',
        args: ['run', 'test/mcp/mock-server.ts'],
      })

      await client.connect({
        name: 'server-b',
        command: 'bun',
        args: ['run', 'test/mcp/mock-server.ts'],
      })

      const connections = client.listConnections()
      expect(connections).toHaveLength(2)
      expect(connections.map((c) => c.config.name)).toContain('server-a')
      expect(connections.map((c) => c.config.name)).toContain('server-b')

      client.disconnect('server-a')
      expect(client.listConnections()).toHaveLength(1)
    })
  })

  describe('closeAll', () => {
    it('closes all connections', async () => {
      const client = McpClient.getInstance()
      await client.connect({
        name: 'mock',
        command: 'bun',
        args: ['run', 'test/mcp/mock-server.ts'],
      })

      await client.closeAll()
      expect(client.listConnections()).toHaveLength(0)
    })
  })

  describe('HTTP connect', () => {
    it('connects to a Streamable HTTP MCP server via url', async () => {
      const mockFetch = vi.fn(async (input: string, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string) as { id: number; method: string }
        const base = { jsonrpc: '2.0', id: body.id }
        if (body.method === 'initialize') {
          return new Response(
            JSON.stringify({
              ...base,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {}, resources: {} },
                serverInfo: { name: 'http-mock', version: '1.0.0' },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (body.method === 'tools/list') {
          return new Response(
            JSON.stringify({
              ...base,
              result: {
                tools: [
                  {
                    name: 'search_graph',
                    description: 'Search entities',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ ...base, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
      vi.stubGlobal('fetch', mockFetch)

      try {
        const client = McpClient.getInstance()
        await client.connect({ name: 'http-mock', url: 'http://localhost:8004/mcp' })

        const conn = client.getConnection('http-mock')
        expect(conn).toBeDefined()
        expect(conn!.status).toBe('connected')
        expect(conn!.serverInfo?.name).toBe('http-mock')
        expect(client.getTools('http-mock').map((t) => t.name)).toContain('search_graph')
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
