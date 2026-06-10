import { describe, it, expect, afterEach } from 'vitest'
import { StdioTransport } from '../../src/mcp/transport'

describe('StdioTransport', () => {
  let transport: StdioTransport

  afterEach(async () => {
    try { await transport?.close() } catch { /* ok */ }
  })

  describe('start and close', () => {
    it('starts a process and connects', async () => {
      transport = new StdioTransport()
      await transport.start('cat', [])
      expect(transport.isConnected()).toBe(true)
      await transport.close()
      expect(transport.isConnected()).toBe(false)
    })

    it('can close before start without error', async () => {
      transport = new StdioTransport()
      await transport.close()
    })

    it('rejects pending requests on close', async () => {
      transport = new StdioTransport()
      await transport.start('sleep', ['10']) // long-running process

      // Send a request that will never receive a response
      const promise = transport.sendRequest('never/responds')
      await transport.close()

      await expect(promise).rejects.toThrow('Transport closed')
    })
  })

  describe('request/response with mock server', () => {
    it('handles initialize handshake', async () => {
      transport = new StdioTransport()
      await transport.start('bun', ['run', 'test/mcp/mock-server.ts'])

      const result = await transport.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'test', version: '1.0.0' },
      })

      expect(result).toBeDefined()
      const r = result as Record<string, unknown>
      expect(r.protocolVersion).toBe('2024-11-05')
      expect(r.capabilities).toBeDefined()

      await transport.close()
    })

    it('discovers tools via tools/list', async () => {
      transport = new StdioTransport()
      await transport.start('bun', ['run', 'test/mcp/mock-server.ts'])

      // Initialize first
      await transport.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'test', version: '1.0.0' },
      })

      const result = await transport.sendRequest('tools/list')
      const r = result as { tools: Array<{ name: string }> }
      expect(r.tools).toHaveLength(2)
      expect(r.tools.map(t => t.name)).toContain('echo')
      expect(r.tools.map(t => t.name)).toContain('add')

      await transport.close()
    })

    it('calls a tool via tools/call', async () => {
      transport = new StdioTransport()
      await transport.start('bun', ['run', 'test/mcp/mock-server.ts'])

      await transport.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'test', version: '1.0.0' },
      })

      const result = await transport.sendRequest('tools/call', {
        name: 'add',
        arguments: { a: 3, b: 4 },
      })
      const r = result as { content: Array<{ text: string }> }
      expect(r.content[0]!.text).toContain('7')

      await transport.close()
    })

    it('receives notifications', async () => {
      transport = new StdioTransport()
      await transport.start('bun', ['run', 'test/mcp/mock-server.ts'])

      const notifications: string[] = []
      transport.onNotification((n) => {
        notifications.push(n.method)
      })

      // Send a request (notifications arrive mixed in)
      await transport.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'test', version: '1.0.0' },
      })

      // Send initialized notification (echo-back won't happen, but test callback wiring)
      transport.sendNotification('notifications/initialized')

      // Allow time for notification to be processed
      await new Promise(r => setTimeout(r, 100))

      await transport.close()
    })
  })

  describe('error handling', () => {
    it('throws on request to closed transport', async () => {
      transport = new StdioTransport()
      await expect(transport.sendRequest('test')).rejects.toThrow('not connected')
    })

    it('rejects pending requests when transport is explicitly closed', async () => {
      transport = new StdioTransport()
      // Start a long-running process that won't exit on its own
      await transport.start('cat', [])

      // Send a request that will never receive a response
      const promise = transport.sendRequest('tools/list')
      // Explicitly close — pending requests should be rejected
      await transport.close()
      await expect(promise).rejects.toThrow('Transport closed')
    })
  })
})
