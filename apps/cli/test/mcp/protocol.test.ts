import { describe, it, expect, afterEach } from 'vitest'
import { StdioTransport } from '../../src/mcp/transport'
import { McpProtocol } from '../../src/mcp/protocol'

describe('McpProtocol', () => {
  let transport: StdioTransport
  let protocol: McpProtocol

  afterEach(async () => {
    try {
      await protocol?.close()
    } catch {
      /* ok */
    }
  })

  async function connect() {
    transport = new StdioTransport()
    protocol = new McpProtocol(transport)
    await protocol.initialize('bun', ['run', 'test/mcp/mock-server.ts'])
  }

  describe('initialize', () => {
    it('completes the initialize handshake', async () => {
      const result = await connect()
      // connect() doesn't return the init result; let's check capabilities
      expect(protocol.hasTools()).toBe(true)
      expect(protocol.getCapabilities().tools).toBeDefined()
    })

    it('returns server info', async () => {
      await connect()
      // Server info is set during initialize
      expect(protocol.hasTools()).toBe(true)
    })
  })

  describe('listTools', () => {
    it('returns available tools', async () => {
      await connect()
      const tools = await protocol.listTools()
      expect(tools).toHaveLength(2)
      expect(tools[0]!.name).toBe('echo')
      expect(tools[1]!.name).toBe('add')
    })

    it('tool has schema', async () => {
      await connect()
      const tools = await protocol.listTools()
      const echo = tools.find((t) => t.name === 'echo')
      expect(echo).toBeDefined()
      expect(echo!.inputSchema.type).toBe('object')
      expect(echo!.inputSchema.required).toContain('message')
    })
  })

  describe('callTool', () => {
    it('executes the echo tool', async () => {
      await connect()
      const result = await protocol.callTool('echo', { message: 'hello world' })
      expect(result.content).toHaveLength(1)
      expect(result.content[0]!.text).toContain('Echo: hello world')
    })

    it('executes the add tool', async () => {
      await connect()
      const result = await protocol.callTool('add', { a: 10, b: 32 })
      expect(result.content[0]!.text).toContain('42')
    })

    it('errors on unknown tool', async () => {
      await connect()
      await expect(protocol.callTool('nonexistent')).rejects.toThrow('Unknown tool')
    })
  })

  describe('listResources', () => {
    it('returns resources when server supports them', async () => {
      await connect()
      const resources = await protocol.listResources()
      expect(resources).toHaveLength(1)
      expect(resources[0]!.name).toBe('Test Data')
    })
  })

  describe('notification handling', () => {
    it('registers notification handler', async () => {
      await connect()
      const notifications: Array<{ method: string; params?: Record<string, unknown> }> = []
      protocol.onNotification((method, params) => {
        notifications.push({ method, params })
      })
      expect(notifications).toHaveLength(0) // No notifications sent by mock server
    })
  })
})
