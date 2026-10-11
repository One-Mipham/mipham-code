import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StdioTransport, MCP_SHUTDOWN_GRACE_MS } from '../../src/mcp/transport'

describe('StdioTransport', () => {
  let transport: StdioTransport

  afterEach(async () => {
    try {
      await transport?.close()
    } catch {
      /* ok */
    }
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
      // Attach the handler **before** awaiting close(): since 296-048 `close()`
      // waits out the shutdown grace period, so the rejection sits handler-less
      // for that whole window and Node reports it as an unhandled rejection —
      // which fails the run even though the assertion itself passes.
      const assertion = expect(promise).rejects.toThrow('Transport closed')
      await transport.close()

      await assertion
    })

    it('times out a hung request at the configured timeout', async () => {
      transport = new StdioTransport(200)
      await transport.start('sleep', ['30'])

      const started = Date.now()
      await expect(transport.sendRequest('tools/call', {})).rejects.toThrow(/request timeout/)
      expect(Date.now() - started).toBeLessThan(1000)
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
      expect(r.tools.map((t) => t.name)).toContain('echo')
      expect(r.tools.map((t) => t.name)).toContain('add')

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
      await new Promise((r) => setTimeout(r, 100))

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
      // Same ordering requirement as above: handler first, then the (now
      // grace-period-long) close.
      const assertion = expect(promise).rejects.toThrow('Transport closed')
      // Explicitly close — pending requests should be rejected
      await transport.close()
      await assertion
    })
  })

  /**
   * 296-048 — 关停宽限：先关 stdin（协议层的关闭信号），给服务器自己退出的机会，
   * 只有宽限期过了还在跑才杀。
   *
   * 三格分别钉住三半，任一半被去掉都有一格转红：
   *   ① 关掉宽限 ⇒ 「等服务退出」那格红；
   *   ② 把宽限写成「盲等 N 毫秒」而不是「等退出事件」⇒ 「自己退出就早返回」那格红；
   *   ③ 只等不杀 ⇒ 「仍在跑的进程最终确实被杀」那格红。
   */
  describe('296-048 关停宽限', () => {
    /** 一个不理会 stdin EOF、只靠信号结束的「服务器」。 */
    const IGNORE_EOF = 'process.stdin.resume();setInterval(() => {}, 1000)'

    const waitForFile = async (file: string, ms = 3000): Promise<string> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (existsSync(file)) return readFileSync(file, 'utf-8').trim()
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error(`child never wrote ${file}`)
    }

    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    it('服务器不理会 EOF ⇒ 关停要**等满**宽限期，不是立刻杀', async () => {
      transport = new StdioTransport()
      await transport.start('bun', ['-e', IGNORE_EOF])

      const started = Date.now()
      await transport.close()
      const elapsed = Date.now() - started

      // 无宽限时这里是几毫秒。下界取常量的 ~80%：不做精确计时，只区分
      // 「等过」与「没等」。
      expect(elapsed).toBeGreaterThanOrEqual(MCP_SHUTDOWN_GRACE_MS * 0.8)
    })

    it('服务器在 EOF 上自己退出 ⇒ **早**于宽限期返回（是等退出事件，不是盲等）', async () => {
      // 给一个大到不可能盲等完的宽限：`cat` 收到 EOF 就退，若实现是「盲等 N 毫秒」，
      // 这里会花 5 秒而不是几十毫秒。
      transport = new StdioTransport(undefined, 5000)
      await transport.start('cat', [])

      const started = Date.now()
      await transport.close()
      expect(Date.now() - started).toBeLessThan(1000)
    })

    it('宽限期后仍在跑的服务器被真的杀掉（不留残进程）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mipham-mcp-296048-'))
      const pidFile = join(dir, 'pid')
      try {
        // 让「服务器」先把自己的 pid 落盘，测试才有一个可查询的对象。
        const withPidFile = `require('fs').writeFileSync(process.env.MCP_PID_FILE, String(process.pid));${IGNORE_EOF}`
        transport = new StdioTransport()
        await transport.start('bun', ['-e', withPidFile], { MCP_PID_FILE: pidFile })
        const pid = Number(await waitForFile(pidFile))
        expect(Number.isInteger(pid), `pidfile 内容不是 pid：${pid}`).toBe(true)

        await transport.close()

        // kill() 到进程被回收之间有一小段窗口，故轮询而不是立刻断言。
        const deadline = Date.now() + 2000
        while (Date.now() < deadline && isAlive(pid)) {
          await new Promise((r) => setTimeout(r, 20))
        }
        expect(isAlive(pid), `pid ${pid} 在 close() 之后仍在运行 —— 关停没有杀它`).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
