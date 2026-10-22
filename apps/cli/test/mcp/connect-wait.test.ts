import { describe, it, expect, afterEach, vi } from 'vitest'
import { McpClient } from '../../src/mcp/client'

/**
 * A caller can arrive while a server is still mid-handshake: startup connects
 * servers without blocking, and the things that fire alongside it — hooks,
 * SessionStart work — see the client in whatever state the handshake has
 * reached. "Not connected yet" and "not there" are different answers, and only
 * one of them is worth waiting for.
 */

function httpMock(delayMs = 0) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const reply = (result: unknown): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (body.method === 'initialize') {
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock', version: '1.0.0' },
      })
    }
    if (body.method === 'tools/list') return reply({ tools: [] })
    return new Response('', { status: 202 })
  }
}

describe('McpClient.waitUntilReady', () => {
  afterEach(async () => {
    await McpClient.getInstance().closeAll()
    McpClient.resetInstance()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('returns at once for a server that was never connecting', async () => {
    // The control for the two below: the method must not simply sleep, so a
    // deadline longer than this whole test is passed and nothing is waited for.
    const started = Date.now()

    const ready = await McpClient.getInstance().waitUntilReady('nobody', 5_000)

    expect(ready).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('returns as soon as a handshake settles', async () => {
    vi.stubGlobal('fetch', httpMock(20))
    const client = McpClient.getInstance()
    const connecting = client.connect({ name: 'ok', url: 'https://example.com/mcp' })

    const ready = await client.waitUntilReady('ok', 2_000)

    expect(ready).toBe(true)
    expect(client.getConnection('ok')!.status).toBe('connected')
    await connecting
  })

  it('gives up at the deadline on a server that never settles', async () => {
    // A server that hangs is the case the deadline exists for: waiting forever
    // is not "waiting for the server", it is a hook that never returns.
    vi.stubEnv('MIPHAM_MCP_CONNECT_TIMEOUT_MS', '150')
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    const client = McpClient.getInstance()
    const connecting = client
      .connect({ name: 'slow', url: 'https://example.com/mcp' })
      .catch(() => {})

    const started = Date.now()
    const ready = await client.waitUntilReady('slow', 60)
    const elapsed = Date.now() - started

    expect(ready).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(2_000)
    await connecting
  })
})

/**
 * 握手预算量的是**醒着的时间**，不是壁钟。
 *
 * 笔记本在握手途中睡过去一小时，`setTimeout` 会在掀开盖子的那一瞬烧掉整个预算
 * ⇒ 服务器被判超时、连接锁成 `error`；而启动只连一次、失败的服务器不注册工具，
 * 于是 `markIfTransportLost` 的自动重连永远够不着它。服务器没问题，是钟走了。
 *
 * 测法同 `test/providers/fetch-utils.test.ts`：`setTimeout` 走假时钟，
 * `performance.now` 手控 ——「宿主机挂起」= 壁钟前进而 `performance.now` 不动。
 */
describe('McpClient connect budget counts awake time', () => {
  afterEach(async () => {
    await McpClient.getInstance().closeAll()
    McpClient.resetInstance()
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  function withAwakeClock(): { advance: (ms: number) => void } {
    let awake = 0
    vi.spyOn(performance, 'now').mockImplementation(() => awake)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    return {
      advance: (ms) => {
        awake += ms
      },
    }
  }

  it('a wall-clock jump with no awake time does not time the handshake out', async () => {
    vi.stubEnv('MIPHAM_MCP_CONNECT_TIMEOUT_MS', '1000')
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    const clock = withAwakeClock()
    const client = McpClient.getInstance()

    let settled = false
    const connecting = client
      .connect({ name: 'sleepy', url: 'https://example.com/mcp' })
      .catch((err: unknown) => {
        settled = true
        return err
      })

    // 合盖一小时：壁钟到点，醒着的时间一秒没走 ⇒ 不能判超时
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled, '睡过去的那一跳不能被当成服务器卡住').toBe(false)

    // 醒来后预算才真正走完
    clock.advance(1000)
    await vi.advanceTimersByTimeAsync(1000)
    const err = await connecting
    expect(err).toBeInstanceOf(Error)
    expect(String(err)).toContain('timed out')
  })

  it('the wait-for-handshake deadline also counts awake time', async () => {
    vi.stubEnv('MIPHAM_MCP_CONNECT_TIMEOUT_MS', '1000')
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    const clock = withAwakeClock()
    const client = McpClient.getInstance()
    const connecting = client
      .connect({ name: 'slow', url: 'https://example.com/mcp' })
      .catch(() => {})

    let verdict: boolean | undefined
    const waiting = client.waitUntilReady('slow', 500).then((ready) => {
      verdict = ready
      return ready
    })

    await vi.advanceTimersByTimeAsync(1000) // 睡着：壁钟前进，醒着时间 0
    expect(verdict, '睡过去不该耗掉等待者的截止时间').toBeUndefined()

    clock.advance(500)
    await vi.advanceTimersByTimeAsync(500)
    expect(await waiting).toBe(false)

    // 等待者先到点，握手自己那 1000ms 预算还差一半。`await connecting` 前必须把
    // 醒着的时间也走完 —— 否则这是在等一个「假时钟下永远不会到点」的连接，
    // 表现是整条用例 5s 超时（而不是断言失败）。
    clock.advance(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await connecting
  })
})
