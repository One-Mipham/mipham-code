// apps/cli/test/daemon/feishu/route.test.ts
//
// `/feishu/event` 的路由级测试。在这条路由上加测试的理由是**在此之前它一条都没有**：
// `grep -rln "feishu/event"` 只命中 `src/daemon/server.ts` 与本目录的 `events.test.ts`，
// 而后者测的是 dispatcher，不是这条路由 —— 于是「限流闸在它下面」（F3-1）这种
// **只有看 server.ts 的语句顺序才能发现**的缺陷，没有任何机械防线。
//
// 两件事在这里被钉住：
//   1. **顺序**：回调在限流**之后**、origin 闸**之前**。签名回答「这次该不该处理」，
//      从不回答「可以来多少次」—— 所以计费对它适用；而它的调用方是服务器不是浏览器页，
//      收 Origin 没有意义。这两条中间件各管一件事，故一个在上、一个在下。
//   2. **单次成本**：超限的体在**解析之前**被拒（413），不是先吞下再回一句 400。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { unlinkSync } from 'node:fs'

const sdkInvokeMock = vi.fn()

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 1 },
  Domain: { Feishu: 'feishu' },
  Client: class {
    im = { message: { create: vi.fn() } }
  },
  EventDispatcher: class {
    register(map: Record<string, (data: any) => unknown>) {
      this._map = map
      return this
    }
    _map: Record<string, (data: any) => unknown> = {}
    async invoke(assigned: unknown) {
      return sdkInvokeMock(assigned, this._map)
    }
  },
}))

import { createServer } from '../../../src/daemon/server'
import { DaemonDatabase } from '../../../src/daemon/database'
import { SessionManager } from '../../../src/daemon/session-manager'
import { AgentManager } from '../../../src/daemon/agent-manager'
import { GoalManager } from '../../../src/daemon/goal-manager'
import { ScheduleManager } from '../../../src/daemon/schedule-manager'
import { WorkerPool } from '../../../src/daemon/worker-pool'
import { generateToken } from '../../../src/daemon/auth'
import { RateLimiter } from '../../../src/daemon/rate-limiter'
import type { Server } from 'bun'

const FEISHU_CONFIG = {
  appId: 'a',
  appSecret: 's',
  encryptKey: 'k',
  verificationToken: 't',
  allowedOpenIds: ['ou_1'],
}

/** 256 KiB 是 adapter 里的上限；这里取两个数量级的余量做正对照。 */
const SMALL_EVENT = { message: { content: '{}' }, sender: { sender_id: { open_id: 'ou_1' } } }

function cleanDb(path: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix)
    } catch {}
  }
}

/**
 * 起一个真的 daemon（Bun.serve 已被 vitest.setup 换成 Node http server），
 * 只有 Feishu 一个渠道。返回 stop()。
 */
async function startDaemon(port: number, rateLimiter: RateLimiter) {
  const dbPath = `/tmp/mipham-feishu-route-${port}.db`
  cleanDb(dbPath)
  const db = new DaemonDatabase(dbPath)
  db.init()
  const sm = new SessionManager(db)
  const pool = new WorkerPool(db)
  const server: Server<any> = createServer({
    db,
    sm,
    pool,
    token: generateToken(),
    tokenPath: `/tmp/mipham-feishu-route-${port}.token`,
    port,
    hostname: '127.0.0.1',
    agentManager: new AgentManager(db),
    goalManager: new GoalManager(db),
    scheduleManager: new ScheduleManager(db, pool),
    rateLimiter,
    feishu: { config: FEISHU_CONFIG, cwd: '/tmp', provider: 'anthropic', model: 'claude' },
  })
  for (let i = 0; i < 50; i++) {
    try {
      // 健康检查本身被限流跳过，故不会吃掉本用例的额度
      await fetch(`http://127.0.0.1:${port}/api/v1/health`)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return {
    async stop() {
      await server.stop()
      db.close()
      cleanDb(dbPath)
    },
  }
}

const post = (port: number, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/feishu/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('POST /feishu/event — 闸的顺序与单次成本', () => {
  const PORT = 46001
  let daemon: { stop(): Promise<void> }

  beforeAll(async () => {
    // 额度充裕：本组测的是顺序与体积，额度留给下一组
    daemon = await startDaemon(PORT, new RateLimiter(1000, 60_000))
  })

  afterAll(async () => {
    await daemon.stop()
  })

  it('带 Origin 也照常处理 —— 回调在 origin 闸之前（有意豁免，别再往下挪）', async () => {
    sdkInvokeMock.mockResolvedValue(undefined) // 验签失败：证明请求真的走到了 dispatcher
    const res = await post(PORT, SMALL_EVENT, { Origin: 'https://browser-page.example' })
    // 403/「Origin not allowed」= 被 origin 闸拦了 ⇒ 那就是把这条分支挪到了它下面。
    // 它不该被拦：调用方是 Feishu 的服务器，不是浏览器页，而它的闸是签名。
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 1, msg: 'invalid_signature' })
  })

  it('未签名事件在这条路由上被拒（签名才是它的闸）', async () => {
    sdkInvokeMock.mockResolvedValue(undefined)
    const res = await post(PORT, SMALL_EVENT)
    expect(res.status).toBe(400)
    expect(sdkInvokeMock).toHaveBeenCalledTimes(1)
  })

  it('challenge 回显在路由上仍可用（这条路径不经签名）', async () => {
    sdkInvokeMock.mockClear()
    const res = await post(PORT, { challenge: 'abc' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ challenge: 'abc' })
    expect(sdkInvokeMock).not.toHaveBeenCalled()
  })

  it('超限的体 → 413，且从未到达 dispatcher（解析之前就拒）', async () => {
    sdkInvokeMock.mockClear()
    const res = await post(PORT, { pad: 'x'.repeat(300 * 1024) })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 1, msg: 'payload_too_large' })
    expect(sdkInvokeMock).not.toHaveBeenCalled()
  })

  it('上限内的体照常走到 dispatcher（正对照：413 不是「什么都拒」）', async () => {
    sdkInvokeMock.mockClear()
    sdkInvokeMock.mockResolvedValue(undefined)
    const res = await post(PORT, { ...SMALL_EVENT, pad: 'x'.repeat(64 * 1024) })
    expect(res.status).toBe(400)
    expect(sdkInvokeMock).toHaveBeenCalledTimes(1)
  })
})

describe('POST /feishu/event — 计费（F3-1 的本体）', () => {
  const PORT = 46002
  const LIMIT = 3
  let daemon: { stop(): Promise<void> }

  beforeAll(async () => {
    daemon = await startDaemon(PORT, new RateLimiter(LIMIT, 60_000))
  })

  afterAll(async () => {
    await daemon.stop()
  })

  it(`前 ${LIMIT} 次放行、第 ${LIMIT + 1} 次 429 —— 回调消耗限流额度`, async () => {
    sdkInvokeMock.mockResolvedValue(undefined)
    const statuses: number[] = []
    for (let i = 0; i < LIMIT + 1; i++) {
      statuses.push((await post(PORT, SMALL_EVENT)).status)
    }
    // 改前这里是 [400,400,400,400] —— 那一格「没有 429」正是 F3-1：
    // 一条路径完全不计数，等于给它开了无限额度的后门。
    expect(statuses).toEqual([400, 400, 400, 429])
  })
})
