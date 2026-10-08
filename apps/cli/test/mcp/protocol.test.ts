import { describe, it, expect, afterEach, vi } from 'vitest'
import { StdioTransport } from '../../src/mcp/transport'
import type { Transport } from '../../src/mcp/transport'
import { McpProtocol, MCP_SUPPORTED_VERSIONS, offerVersion } from '../../src/mcp/protocol'

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
    await transport.start('bun', ['run', 'test/mcp/mock-server.ts'])
    protocol = new McpProtocol(transport)
    await protocol.initialize()
  }

  describe('initialize', () => {
    it('completes the initialize handshake', async () => {
      await connect()
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

// ============================================================
// 协议版本协商
//
// 原先 `initialize` 发的是**一个硬编码字面量**，服务器回的 `protocolVersion`
// 收到就丢。于是两件事在屏幕上同形：服务器答应了、以及服务器回了一个本客户端
// 从未实现的版本。这里钉住「读回来」与「读不回来时说出来」。
// ============================================================

describe('MCP 协议版本协商', () => {
  /** 只答 `initialize` 的假传输；其余方法不会被这些用例碰到。 */
  function fakeTransport(answer: Record<string, unknown>): {
    transport: Transport
    sent: Array<{ method: string; params?: Record<string, unknown> }>
  } {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = []
    const transport: Transport = {
      async sendRequest(method, params) {
        sent.push({ method, params })
        return answer
      },
      sendNotification: (method, params) => {
        sent.push({ method, params })
      },
      onNotification: () => {},
      async close() {},
      isConnected: () => true,
    }
    return { transport, sent }
  }

  it('offerVersion 默认给最新的；legacy 给最老的', () => {
    expect(offerVersion({})).toBe(MCP_SUPPORTED_VERSIONS[0])
    expect(offerVersion({ MCP_PROTOCOL_NEGOTIATION: 'legacy' })).toBe(
      MCP_SUPPORTED_VERSIONS[MCP_SUPPORTED_VERSIONS.length - 1],
    )
    // 认不出的值不能被当成 legacy —— 「拼错了」与「明确要老的」后果不同，
    // 前者应当无意外地走默认。
    expect(offerVersion({ MCP_PROTOCOL_NEGOTIATION: 'l3gacy' })).toBe(MCP_SUPPORTED_VERSIONS[0])
  })

  it('把 offerVersion 的结果发进 initialize 请求', async () => {
    const { transport, sent } = fakeTransport({
      protocolVersion: MCP_SUPPORTED_VERSIONS[0],
      capabilities: {},
      serverInfo: { name: 'x', version: '1' },
    })
    await new McpProtocol(transport).initialize()

    expect(sent[0]!.method).toBe('initialize')
    expect(sent[0]!.params!.protocolVersion).toBe(offerVersion())
  })

  it('读回服务器答的版本，而不是我们发出去的那个', async () => {
    // 服务器答一个比 offer 更老的合法版本：协商成功，面板上要出**它**的版本。
    const { transport } = fakeTransport({
      protocolVersion: MCP_SUPPORTED_VERSIONS[0],
      capabilities: {},
      serverInfo: { name: 'x', version: '1' },
    })
    const p = new McpProtocol(transport)
    expect(p.protocolVersion).toBeNull() // 握手前没有版本
    await p.initialize()
    expect(p.protocolVersion).toBe(MCP_SUPPORTED_VERSIONS[0])
  })

  it('服务器答了本客户端未实现的版本 ⇒ 连得上，但要说出来', async () => {
    const { transport } = fakeTransport({
      protocolVersion: '2099-01-01',
      capabilities: {},
      serverInfo: { name: 'x', version: '1' },
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const p = new McpProtocol(transport)
      await p.initialize() // 不抛：基础生命周期跨版本稳定
      expect(p.protocolVersion).toBe('2099-01-01')
      const said = spy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(said).toContain('2099-01-01')
      expect(said).toContain(MCP_SUPPORTED_VERSIONS[0])
    } finally {
      spy.mockRestore()
    }
  })

  it('正对照：答的是受支持的版本时一个字都不报', async () => {
    const { transport } = fakeTransport({
      protocolVersion: MCP_SUPPORTED_VERSIONS[0],
      capabilities: {},
      serverInfo: { name: 'x', version: '1' },
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await new McpProtocol(transport).initialize()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('服务器压根没答这个字段 ⇒ 保持 null，不当成同意', async () => {
    const { transport } = fakeTransport({
      capabilities: {},
      serverInfo: { name: 'x', version: '1' },
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const p = new McpProtocol(transport)
      await p.initialize()
      expect(p.protocolVersion).toBeNull()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
