# 企业微信 Bot 远程控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Mipham Code daemon 加企业微信远程控制：用户企微单聊智能机器人发消息，daemon 长连接收消息、跑会话、回传结果。

**Architecture:** 在 daemon 内新增 `src/daemon/wecom/` 模块（types/env/api/ws-client/adapter），长连接 WebSocket（`globalThis.WebSocket` 零依赖）驱动；这是第 3 个频道，先抽共享 `channel-message.ts` 骨架（rule of three），再镜像 feishu/telegram 模式；会话映射复用已泛化的 `getOrCreateByExternalUser(channel, userId)`（零改动）。

**Tech Stack:** TypeScript strict + ESM（`.js` 导入后缀）；Bun/Node 原生 `globalThis.WebSocket`；Vitest 3；SQLite（daemon 现用）。

**Spec:** `docs/superpowers/specs/2026-08-21-wecom-remote-control-design.md`

## Global Constraints

- 零新增依赖：WebSocket 走 `globalThis.WebSocket`（Bun + Node 22+ 原生），不引 `ws`。
- ESM 导入必须带 `.js` 后缀（daemon 现有约定，如 `from './api.js'`）。
- 凭据只走 env（`WECOM_BOT_ID` / `WECOM_BOT_SECRET`），禁止硬编码/日志。
- fail-closed：缺 botId 或 secret → daemon 不启用企微（返回 `null`）。
- daemon 会话权限 `default`（headless 最小权限），不新增权限模式。
- 提交遵循 CLAUDE.md「禁止自动提交」：每任务末尾的 commit 步骤仅在用户明确授权后执行；未授权则跳过 commit，改动留工作区。
- 测试命令：`cd apps/cli && pnpm test`；单文件 `pnpm test <path>`。
- **帧结构核对**：`aibot_subscribe` / `aibot_respond_msg` / `aibot_msg_callback` 的精确 JSON 字段以官方文档 `developer.work.weixin.qq.com/document/path/101463` 为准；本 plan 的帧结构基于 cc-connect / OpenClaw 参考实现，**实现时逐字段核对**（spec §4.1 同注）。

---

## 文件结构

```
src/daemon/channel-message.ts         handleChannelMessage(): 三频道共享骨架（rule of three）
src/daemon/feishu/adapter.ts          onMessage 改为调 handleChannelMessage（surgical 重构）
src/daemon/telegram/adapter.ts        handleMessage 改为调 handleChannelMessage（surgical 重构）

src/daemon/wecom/
├── types.ts          WecomConfig + WecomMessage（纯类型）
├── env.ts            parseWecomEnv(): fail-closed 环境解析
├── api.ts            createWecomApi(): open/subscribe/ping/respond/parseMessage/isDisconnected（无状态帧）
├── ws-client.ts      nextBackoff（纯函数）+ startWecomWs（连接生命周期：心跳+重连）
└── adapter.ts        createWecomAdapter(): 复用 handleChannelMessage 骨架

src/daemon/server.ts              ServerConfig 加 wecom? + createWecomAdapter + 心跳 push
src/daemon/index.ts               解析 parseWecomEnv + 注入 wecom 配置

test/daemon/channel-message.test.ts  骨架一致性测试
test/daemon/wecom/                   env/api/ws-client/adapter/integration 五个测试
```

---

### Task 1: 抽 `channel-message.ts` 共享骨架（rule of three）

**Files:**

- Create: `src/daemon/channel-message.ts`
- Modify: `src/daemon/feishu/adapter.ts:26-54`（onMessage 体）
- Modify: `src/daemon/telegram/adapter.ts:31-59`（handleMessage 体）
- Test: `test/daemon/channel-message.test.ts`

**Interfaces:**

- Consumes: `getOrCreateByExternalUser`（SessionManager 现成）、`RateLimiter.check`、`SessionWorker.processPrompt`/`getLastAssistantContent`（现成）。
- Produces: `handleChannelMessage(opts: ChannelMessageOptions): Promise<void>`——Task 5（wecom adapter）及 feishu/telegram adapter 依赖。`ChannelMessageOptions` 签名见 Step 3。

- [ ] **Step 1: 写失败测试**

`test/daemon/channel-message.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { handleChannelMessage } from '../../src/daemon/channel-message.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

function makeOpts(overrides: Partial<any> = {}) {
  const processPrompt = vi.fn(async () => {})
  const worker = {
    processPrompt,
    getLastAssistantContent: () => '完成！',
  }
  return {
    channel: 'feishu',
    externalId: 'ou_1',
    text: 'hi',
    allowed: new Set(['ou_1']),
    rateLimiter: { check: vi.fn(() => ({ allowed: true })) } as any,
    sm: {
      getOrCreateByExternalUser: vi.fn(() => ({ id: 'sess-1' })),
    } as any,
    getOrCreateWorker: vi.fn(() => worker) as any,
    cwd: '/tmp',
    provider: 'anthropic',
    model: 'claude',
    sendText: vi.fn(async () => {}),
    maxLen: 4000,
    logPrefix: '[feishu]',
    ...overrides,
  }
}

describe('handleChannelMessage', () => {
  it('白名单 miss → 不跑 prompt 不回发', async () => {
    const o = makeOpts({ allowed: new Set([]) })
    await handleChannelMessage(o)
    expect(o.sm.getOrCreateByExternalUser).not.toHaveBeenCalled()
    expect(o.sendText).not.toHaveBeenCalled()
  })

  it('白名单 hit → processPrompt 一次 + 回发最终内容', async () => {
    const o = makeOpts()
    await handleChannelMessage(o)
    expect(o.sm.getOrCreateByExternalUser).toHaveBeenCalledWith(
      'feishu',
      'ou_1',
      '/tmp',
      'anthropic',
      'claude',
    )
    expect(o.sendText).toHaveBeenCalledWith('ou_1', '完成！')
  })

  it('worker null → 回发「初始化失败」', async () => {
    const o = makeOpts({ getOrCreateWorker: () => null })
    await handleChannelMessage(o)
    expect(o.sendText).toHaveBeenCalledWith('ou_1', '（会话初始化失败，请稍后重试）')
  })

  it('回发失败 → 不 rethrow，prompt 只跑一次', async () => {
    const o = makeOpts()
    o.sendText.mockRejectedValue(new Error('send failed'))
    await expect(handleChannelMessage(o)).resolves.toBeUndefined()
    expect(o.getOrCreateWorker).toHaveBeenCalledTimes(1)
  })

  it('截断超长回复到 maxLen', async () => {
    const o = makeOpts({ maxLen: 5 })
    ;(o.getOrCreateWorker() as any).getLastAssistantContent = () => 'abcdefghij'
    await handleChannelMessage(o)
    expect(o.sendText).toHaveBeenCalledWith('ou_1', 'abcde')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/daemon/channel-message.test.ts`
Expected: FAIL（`Cannot find module .../channel-message.js`）。

- [ ] **Step 3: 实现**

`src/daemon/channel-message.ts`：

```ts
import type { SessionManager } from './session-manager'
import type { SessionWorker } from './session-worker'
import type { RateLimiter } from './rate-limiter'

export interface ChannelMessageOptions {
  channel: string // 'feishu' | 'telegram' | 'wecom'
  externalId: string // openId / chatId / userId
  text: string
  allowed: Set<string>
  rateLimiter: RateLimiter
  sm: SessionManager
  getOrCreateWorker: (sessionId: string) => SessionWorker | null
  cwd: string
  provider: string
  model: string
  sendText: (externalId: string, text: string) => Promise<void>
  maxLen: number // 飞书 4000 / Telegram 4096 / 企微 2048
  logPrefix: string // '[feishu]' / '[telegram]' / '[wecom]'
}

/** 三频道共享的消息处理骨架：白名单→限流→会话→processPrompt→回发。 */
export async function handleChannelMessage(opts: ChannelMessageOptions): Promise<void> {
  const {
    channel,
    externalId,
    text,
    allowed,
    rateLimiter,
    sm,
    getOrCreateWorker,
    cwd,
    provider,
    model,
    sendText,
    maxLen,
    logPrefix,
  } = opts
  try {
    if (!allowed.has(externalId)) return
    if (!rateLimiter.check(`${channel}:${externalId}`).allowed) return

    const session = sm.getOrCreateByExternalUser(channel, externalId, cwd, provider, model)
    const worker = getOrCreateWorker(session.id)
    if (!worker) {
      await sendText(externalId, '（会话初始化失败，请稍后重试）')
      return
    }
    await worker.processPrompt(text)
    const result = worker.getLastAssistantContent()
    await sendText(externalId, result ? result.slice(0, maxLen) : '（无回复）')
  } catch (err) {
    console.error(`${logPrefix} message handling failed:`, err)
    try {
      await sendText(externalId, '（处理失败，请稍后重试）')
    } catch {
      /* 忽略回送失败，不 rethrow */
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/channel-message.test.ts`
Expected: PASS。

- [ ] **Step 5: 重构 feishu adapter（surgical，只替换 onMessage 体）**

`src/daemon/feishu/adapter.ts`：顶部加 import：

```ts
import { handleChannelMessage } from '../channel-message.js'
```

把 `onMessage`（第 26-54 行）整段替换为：

```ts
const onMessage = async (msg: FeishuTextMessage) => {
  await handleChannelMessage({
    channel: 'feishu',
    externalId: msg.openId,
    text: msg.text,
    allowed,
    rateLimiter: deps.rateLimiter,
    sm: deps.sm,
    getOrCreateWorker: deps.getOrCreateWorker,
    cwd: deps.cwd,
    provider: deps.provider,
    model: deps.model,
    sendText: (id, t) => api.sendText(id, t),
    maxLen: 4000,
    logPrefix: '[feishu]',
  })
}
```

- [ ] **Step 6: 重构 telegram adapter（surgical，只替换 handleMessage 体）**

`src/daemon/telegram/adapter.ts`：顶部加 import：

```ts
import { handleChannelMessage } from '../channel-message.js'
```

把 `handleMessage`（第 31-59 行）整段替换为：

```ts
async function handleMessage(msg: TelegramMessage): Promise<void> {
  await handleChannelMessage({
    channel: 'telegram',
    externalId: msg.chatId,
    text: msg.text,
    allowed,
    rateLimiter: deps.rateLimiter,
    sm: deps.sm,
    getOrCreateWorker: deps.getOrCreateWorker,
    cwd: deps.cwd,
    provider: deps.provider,
    model: deps.model,
    sendText: (id, t) => api.sendText(id, t),
    maxLen: 4096,
    logPrefix: '[telegram]',
  })
}
```

> 注意：`handleMessage` 仍被 poller 通过 `startTelegramPoller(api, handleMessage)` 引用，签名不变；`isAllowed`/`start` 不动。feishu 的 `handleEvent`/`isAllowed` 不动。

- [ ] **Step 7: 跑既有测试确认不回归**

Run: `cd apps/cli && pnpm test test/daemon/feishu test/daemon/telegram`
Expected: PASS（feishu/telegram adapter 既有测试断言不变，重构后应仍绿）。

- [ ] **Step 8: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/channel-message.ts apps/cli/src/daemon/feishu/adapter.ts apps/cli/src/daemon/telegram/adapter.ts apps/cli/test/daemon/channel-message.test.ts
git commit -m "refactor(daemon): extract shared channel-message handler (rule of three)"
```

---

### Task 2: `wecom/types.ts` + `wecom/env.ts`

**Files:**

- Create: `src/daemon/wecom/types.ts`
- Create: `src/daemon/wecom/env.ts`
- Test: `test/daemon/wecom/env.test.ts`

**Interfaces:**

- Consumes: 无。
- Produces: `WecomConfig { botId: string; botSecret: string; allowedUserIds: string[] }`、`WecomMessage { userId: string; chatId: string; msgId: string; text: string }`、`parseWecomEnv(): WecomConfig | null`——Task 3/5/6 依赖。

- [ ] **Step 1: 写失败测试**

`test/daemon/wecom/env.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { parseWecomEnv } from '../../../src/daemon/wecom/env.js'

afterEach(() => {
  delete process.env.WECOM_BOT_ID
  delete process.env.WECOM_BOT_SECRET
  delete process.env.WECOM_ALLOWED_USER_IDS
})

describe('parseWecomEnv', () => {
  it('缺 botId → null（fail-closed）', () => {
    process.env.WECOM_BOT_SECRET = 's'
    expect(parseWecomEnv()).toBeNull()
  })

  it('缺 botSecret → null（fail-closed）', () => {
    process.env.WECOM_BOT_ID = 'b'
    expect(parseWecomEnv()).toBeNull()
  })

  it('有 botId+botSecret 无白名单 → 空数组', () => {
    process.env.WECOM_BOT_ID = 'b'
    process.env.WECOM_BOT_SECRET = 's'
    expect(parseWecomEnv()).toEqual({ botId: 'b', botSecret: 's', allowedUserIds: [] })
  })

  it('白名单逗号分隔 trim + 过滤空项', () => {
    process.env.WECOM_BOT_ID = 'b'
    process.env.WECOM_BOT_SECRET = 's'
    process.env.WECOM_ALLOWED_USER_IDS = ' alice , bob ,,  '
    expect(parseWecomEnv()!.allowedUserIds).toEqual(['alice', 'bob'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/daemon/wecom/env.test.ts`
Expected: FAIL（`Cannot find module .../wecom/env.js`）。

- [ ] **Step 3: 实现**

`src/daemon/wecom/types.ts`：

```ts
export interface WecomConfig {
  botId: string
  botSecret: string
  allowedUserIds: string[] // 白名单（企微内部 userid）
}

export interface WecomMessage {
  userId: string // 发消息用户（userid）
  chatId: string // 会话 id（chatid）
  msgId: string // 消息 id（req_id 关联回包）
  text: string // 文本内容
}
```

`src/daemon/wecom/env.ts`：

```ts
import type { WecomConfig } from './types.js'

/** fail-closed：缺 botId 或 botSecret → null（daemon 不启用企微）。 */
export function parseWecomEnv(): WecomConfig | null {
  const botId = process.env.WECOM_BOT_ID
  const botSecret = process.env.WECOM_BOT_SECRET
  if (!botId || !botSecret) return null
  return {
    botId,
    botSecret,
    allowedUserIds: (process.env.WECOM_ALLOWED_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/wecom/env.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/wecom/types.ts apps/cli/src/daemon/wecom/env.ts apps/cli/test/daemon/wecom/env.test.ts
git commit -m "feat(wecom): add types + fail-closed env parsing"
```

---

### Task 3: `wecom/api.ts`（协议帧 codec，内部持有 activeWs）

**Files:**

- Create: `src/daemon/wecom/api.ts`
- Test: `test/daemon/wecom/api.test.ts`

**Interfaces:**

- Consumes: `WecomConfig`/`WecomMessage`（Task 2）。
- Produces: `createWecomApi(config): WecomApi`，其中 `WecomApi { open(): WebSocket; subscribe(ws): void; ping(ws): void; attach(ws: WebSocket | null): void; respond(userId: string, text: string): void; parseMessage(frame: unknown): WecomMessage | null; isDisconnected(frame: unknown): boolean }`——Task 4/5 依赖。`respond` 用 `attach` 注入的当前连接（ws-client 建连时 `attach(ws)`、断开时 `attach(null)`）。

> **帧结构以官方文档为准**（Global Constraints 已注明）。本 task 的帧结构为可运行近似，实现时核对 `aibot_msg_callback` body 的 `userid`/`chatid`/`msg_id`/`content` 字段。

- [ ] **Step 1: 写失败测试**

`test/daemon/wecom/api.test.ts`：

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createWecomApi } from '../../../src/daemon/wecom/api.js'

class MockWS {
  static instances: MockWS[] = []
  sent: string[] = []
  constructor(_url: string) {
    MockWS.instances.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
}

afterEach(() => {
  MockWS.instances = []
  vi.unstubAllGlobals()
})

function stubWs() {
  vi.stubGlobal('WebSocket', MockWS as any)
  const api = createWecomApi({ botId: 'b', botSecret: 's', allowedUserIds: [] })
  const ws = api.open()
  return { api, ws }
}

describe('createWecomApi', () => {
  it('open 建连到官方 wss 端点', () => {
    const { ws } = stubWs()
    expect(MockWS.instances[0]).toBe(ws as any)
  })

  it('subscribe 发送 aibot_subscribe + bot_id/secret', () => {
    const { api, ws } = stubWs()
    api.subscribe(ws)
    const frame = JSON.parse((ws as any).sent[0])
    expect(frame.cmd).toBe('aibot_subscribe')
    expect(frame.body).toMatchObject({ bot_id: 'b', bot_secret: 's' })
  })

  it('ping 发送 ping 帧', () => {
    const { api, ws } = stubWs()
    api.ping(ws)
    expect(JSON.parse((ws as any).sent[0]).cmd).toBe('ping')
  })

  it('attach 后 respond 发送 aibot_respond_msg + 文本', () => {
    const { api, ws } = stubWs()
    api.attach(ws)
    api.respond('alice', 'hello')
    const frame = JSON.parse((ws as any).sent[0])
    expect(frame.cmd).toBe('aibot_respond_msg')
    expect(JSON.stringify(frame)).toContain('hello')
  })

  it('未 attach → respond 静默 no-op', () => {
    const { api } = stubWs()
    expect(() => api.respond('alice', 'hello')).not.toThrow()
  })

  it('parseMessage 解析 aibot_msg_callback → WecomMessage', () => {
    const { api } = stubWs()
    const m = api.parseMessage({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'r1' },
      body: { userid: 'alice', chatid: 'c1', msg_id: 'm1', content: 'hi' },
    })
    expect(m).toEqual({ userId: 'alice', chatId: 'c1', msgId: 'm1', text: 'hi' })
  })

  it('parseMessage 非消息帧 → null', () => {
    const { api } = stubWs()
    expect(api.parseMessage({ cmd: 'enter_chat' })).toBeNull()
    expect(api.parseMessage({})).toBeNull()
  })

  it('isDisconnected 识别 disconnected_event', () => {
    const { api } = stubWs()
    expect(api.isDisconnected({ cmd: 'disconnected_event' })).toBe(true)
    expect(api.isDisconnected({ cmd: 'aibot_msg_callback' })).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/daemon/wecom/api.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/daemon/wecom/api.ts`：

```ts
import type { WecomConfig, WecomMessage } from './types.js'

export interface WecomApi {
  open(): WebSocket
  subscribe(ws: WebSocket): void
  ping(ws: WebSocket): void
  attach(ws: WebSocket | null): void
  respond(userId: string, text: string): void
  parseMessage(frame: unknown): WecomMessage | null
  isDisconnected(frame: unknown): boolean
}

const WS_ENDPOINT = 'wss://openws.work.weixin.qq.com'

/** 协议帧 codec；内部持有 activeWs（由 ws-client attach）。零依赖（globalThis.WebSocket）。 */
export function createWecomApi(config: WecomConfig): WecomApi {
  let activeWs: WebSocket | null = null
  return {
    open() {
      return new WebSocket(WS_ENDPOINT)
    },
    subscribe(ws) {
      ws.send(
        JSON.stringify({
          cmd: 'aibot_subscribe',
          body: { bot_id: config.botId, bot_secret: config.botSecret },
        }),
      )
    },
    ping(ws) {
      ws.send(JSON.stringify({ cmd: 'ping' }))
    },
    attach(ws) {
      activeWs = ws
    },
    respond(userId, text) {
      if (activeWs) {
        activeWs.send(
          JSON.stringify({ cmd: 'aibot_respond_msg', body: { userid: userId, content: text } }),
        )
      }
    },
    parseMessage(frame) {
      const f = frame as {
        cmd?: string
        body?: { userid?: string; chatid?: string; msg_id?: string; content?: string }
      }
      if (f.cmd !== 'aibot_msg_callback' || !f.body) return null
      const { userid, chatid, msg_id, content } = f.body
      if (!userid || !content) return null
      return { userId: userid, chatId: chatid ?? '', msgId: msg_id ?? '', text: content }
    },
    isDisconnected(frame) {
      return (frame as { cmd?: string })?.cmd === 'disconnected_event'
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/wecom/api.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/wecom/api.ts apps/cli/test/daemon/wecom/api.test.ts
git commit -m "feat(wecom): add stateless WebSocket frame codec"
```

---

### Task 4: `wecom/ws-client.ts`（心跳 + 重连）

**Files:**

- Create: `src/daemon/wecom/ws-client.ts`
- Test: `test/daemon/wecom/ws-client.test.ts`

**Interfaces:**

- Consumes: `WecomApi`（Task 3）、`WecomMessage`（Task 2）。
- Produces: `nextBackoff(currentMs: number): number`、`startWecomWs(api: WecomApi, onMessage: (msg: WecomMessage) => Promise<void>, opts?: { heartbeatMs?: number }): () => void`——Task 5 依赖。

- [ ] **Step 1: 写失败测试（纯函数 + 生命周期）**

`test/daemon/wecom/ws-client.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextBackoff, startWecomWs } from '../../../src/daemon/wecom/ws-client.js'

describe('nextBackoff', () => {
  it('指数退避', () => expect(nextBackoff(1000)).toBe(2000))
  it('封顶 30s', () => expect(nextBackoff(20000)).toBe(30000))
})

class MockWS {
  static instances: MockWS[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  closed = false
  constructor(_url: string) {
    MockWS.instances.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.closed = true
    this.onclose?.()
  }
  emitOpen() {
    this.onopen?.()
  }
  emitMessage(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function makeApi() {
  return {
    open: () => new MockWS('x'),
    subscribe: vi.fn(),
    ping: vi.fn(),
    attach: vi.fn(),
    respond: vi.fn(),
    parseMessage: (f: any) =>
      f.cmd === 'aibot_msg_callback'
        ? { userId: 'alice', chatId: 'c1', msgId: 'm1', text: f.body.content }
        : null,
    isDisconnected: (f: any) => f.cmd === 'disconnected_event',
  } as any
}

afterEach(() => {
  MockWS.instances = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('startWecomWs', () => {
  it('onopen → 发 subscribe', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startWecomWs(
      api,
      vi.fn(async () => {}),
    )
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    expect(api.subscribe).toHaveBeenCalledWith(ws)
    stop()
  })

  it('aibot_msg_callback → onMessage 调用', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const onMessage = vi.fn(async () => {})
    const stop = startWecomWs(api, onMessage)
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    ws.emitMessage({ cmd: 'aibot_msg_callback', body: { content: 'hi' } })
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }))
    stop()
  })

  it('心跳定时器每 30s 发 ping', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startWecomWs(
      api,
      vi.fn(async () => {}),
    )
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    vi.advanceTimersByTime(30_000)
    expect(api.ping).toHaveBeenCalledWith(ws)
    stop()
  })

  it('disconnected_event → 主动 close 不重连', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startWecomWs(
      api,
      vi.fn(async () => {}),
    )
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    ws.emitMessage({ cmd: 'disconnected_event' })
    expect(ws.closed).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(MockWS.instances.length).toBe(1) // 未重连
    stop()
  })

  it('onclose → 指数退避重连', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startWecomWs(
      api,
      vi.fn(async () => {}),
    )
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    ws.onclose?.() // 模拟服务端断开（非 disconnected_event）
    vi.advanceTimersByTime(1_000)
    expect(MockWS.instances.length).toBe(2) // 1s 后重连
    stop()
  })

  it('stop → 停止重连 + 清定时器', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startWecomWs(
      api,
      vi.fn(async () => {}),
    )
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    stop()
    ws.onclose?.()
    vi.advanceTimersByTime(60_000)
    expect(MockWS.instances.length).toBe(1) // stop 后不重连
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/daemon/wecom/ws-client.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/daemon/wecom/ws-client.ts`：

```ts
import type { WecomApi } from './api.js'
import type { WecomMessage } from './types.js'

/** 指数退避，封顶 30s。与 telegram poller.nextBackoff 同源。 */
export function nextBackoff(currentMs: number): number {
  return Math.min(currentMs * 2, 30_000)
}

/** WebSocket 长连接生命周期：建连→subscribe→心跳→消息回调→断开重连。返回 stop。 */
export function startWecomWs(
  api: WecomApi,
  onMessage: (msg: WecomMessage) => Promise<void>,
  opts?: { heartbeatMs?: number },
): () => void {
  const heartbeatMs = opts?.heartbeatMs ?? 30_000
  let stopped = false
  let disconnected = false // disconnected_event 触发时置 true，主动 close 后不重连
  let ws: WebSocket
  let backoffMs = 1000
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    heartbeatTimer = null
    reconnectTimer = null
  }

  function connect() {
    if (stopped) return
    ws = api.open()
    ws.onopen = () => {
      backoffMs = 1000
      api.attach(ws)
      api.subscribe(ws)
      heartbeatTimer = setInterval(() => api.ping(ws), heartbeatMs)
      ;(heartbeatTimer as unknown as { unref?: () => void }).unref?.()
    }
    ws.onmessage = (ev) => {
      let frame: unknown
      try {
        frame = JSON.parse(ev.data as string)
      } catch {
        return
      }
      if (api.isDisconnected(frame)) {
        disconnected = true
        ws.close()
        return
      }
      const msg = api.parseMessage(frame)
      if (msg) void onMessage(msg).catch(() => {})
    }
    ws.onclose = () => {
      api.attach(null)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = null
      if (stopped || disconnected) return
      reconnectTimer = setTimeout(connect, backoffMs)
      backoffMs = nextBackoff(backoffMs)
      ;(reconnectTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  connect()
  return () => {
    stopped = true
    disconnected = true
    clearTimers()
    try {
      ws.close()
    } catch {
      /* 连接尚未建立时 close 可能抛错，忽略 */
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/wecom/ws-client.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/wecom/ws-client.ts apps/cli/test/daemon/wecom/ws-client.test.ts
git commit -m "feat(wecom): add WebSocket client with heartbeat + reconnect"
```

---

### Task 5: `wecom/adapter.ts`（业务编排，复用骨架）

**Files:**

- Create: `src/daemon/wecom/adapter.ts`
- Test: `test/daemon/wecom/adapter.test.ts`

**Interfaces:**

- Consumes: `WecomConfig`/`WecomMessage`（Task 2）、`WecomApi`（Task 3）、`startWecomWs`（Task 4）、`handleChannelMessage`（Task 1）。
- Produces: `createWecomAdapter(config, api, deps): WecomAdapter`，其中 `WecomAdapter { start(): () => void; handleMessage(msg: WecomMessage): Promise<void>; isAllowed(userId: string): boolean }`；`WecomAdapterDeps { sm; getOrCreateWorker; rateLimiter; cwd; provider; model }`——Task 6 依赖。

- [ ] **Step 1: 写失败测试**

`test/daemon/wecom/adapter.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { createWecomAdapter } from '../../../src/daemon/wecom/adapter.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

const config = { botId: 'b', botSecret: 's', allowedUserIds: ['alice'] }

function makeDeps() {
  const processPrompt = vi.fn(async () => {})
  return {
    processPrompt,
    sm: {
      getOrCreateByExternalUser: vi.fn(() => ({ id: 'sess-1', name: 'wecom-alice' })),
    } as any,
    getOrCreateWorker: vi.fn(() => ({
      processPrompt,
      getLastAssistantContent: () => '完成！',
    })) as any,
    rateLimiter: { check: vi.fn(() => ({ allowed: true })) } as any,
    cwd: '/tmp',
    provider: 'anthropic',
    model: 'claude',
  }
}

function makeApi() {
  return {
    open: vi.fn(() => ({
      set onopen(_: any) {},
      set onmessage(_: any) {},
      set onclose(_: any) {},
      send() {},
      close() {},
    })),
    subscribe: vi.fn(),
    ping: vi.fn(),
    attach: vi.fn(),
    respond: vi.fn(async () => {}),
    parseMessage: vi.fn(() => null),
    isDisconnected: vi.fn(() => false),
  } as any
}

describe('createWecomAdapter', () => {
  it('白名单 miss → 不跑 prompt 不回发', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createWecomAdapter({ ...config, allowedUserIds: [] }, api, deps)
    await a.handleMessage({ userId: 'alice', chatId: 'c1', msgId: 'm1', text: 'hi' })
    expect(deps.processPrompt).not.toHaveBeenCalled()
    expect(api.respond).not.toHaveBeenCalled()
  })

  it('白名单 hit → processPrompt 一次 + respond 回发', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createWecomAdapter(config, api, deps)
    await a.handleMessage({ userId: 'alice', chatId: 'c1', msgId: 'm1', text: 'hi' })
    expect(deps.processPrompt).toHaveBeenCalledWith('hi')
    expect(api.respond).toHaveBeenCalledWith('alice', '完成！')
  })

  it('会话映射用 wecom channel + userId', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createWecomAdapter(config, api, deps)
    await a.handleMessage({ userId: 'alice', chatId: 'c1', msgId: 'm1', text: 'hi' })
    expect(deps.sm.getOrCreateByExternalUser).toHaveBeenCalledWith(
      'wecom',
      'alice',
      '/tmp',
      'anthropic',
      'claude',
    )
  })

  it('start 幂等：重复调用返回同一 stop', () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createWecomAdapter(config, api, deps)
    const s1 = a.start()
    const s2 = a.start()
    expect(s1).toBe(s2)
    s1()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/daemon/wecom/adapter.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/daemon/wecom/adapter.ts`：

```ts
import type { WecomApi } from './api.js'
import type { WecomConfig, WecomMessage } from './types.js'
import type { SessionManager } from '../session-manager'
import type { SessionWorker } from '../session-worker'
import type { RateLimiter } from '../rate-limiter'
import { startWecomWs } from './ws-client.js'
import { handleChannelMessage } from '../channel-message.js'

export interface WecomAdapterDeps {
  sm: SessionManager
  getOrCreateWorker: (sessionId: string) => SessionWorker | null
  rateLimiter: RateLimiter
  cwd: string
  provider: string
  model: string
}

export interface WecomAdapter {
  start(): () => void
  handleMessage(msg: WecomMessage): Promise<void>
  isAllowed(userId: string): boolean
}

export function createWecomAdapter(
  config: WecomConfig,
  api: WecomApi,
  deps: WecomAdapterDeps,
): WecomAdapter {
  const allowed = new Set(config.allowedUserIds)
  let stopWs: (() => void) | null = null

  async function handleMessage(msg: WecomMessage): Promise<void> {
    await handleChannelMessage({
      channel: 'wecom',
      externalId: msg.userId,
      text: msg.text,
      allowed,
      rateLimiter: deps.rateLimiter,
      sm: deps.sm,
      getOrCreateWorker: deps.getOrCreateWorker,
      cwd: deps.cwd,
      provider: deps.provider,
      model: deps.model,
      sendText: async (userId, text) => {
        api.respond(userId, text)
      },
      maxLen: 2048,
      logPrefix: '[wecom]',
    })
  }

  return {
    handleMessage,
    isAllowed: (userId) => allowed.has(userId),
    start() {
      if (stopWs) return stopWs
      stopWs = startWecomWs(api, handleMessage)
      return stopWs
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/wecom/adapter.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/wecom/adapter.ts apps/cli/test/daemon/wecom/adapter.test.ts
git commit -m "feat(wecom): add adapter — whitelist/session/prompt/reply"
```

---

### Task 6: `server.ts` + `index.ts` 接线 + 心跳

**Files:**

- Modify: `src/daemon/server.ts`（ServerConfig 加 `wecom?`、建 adapter + 心跳 push）
- Modify: `src/daemon/index.ts`（解析 `parseWecomEnv` + 注入 `wecom`）

**Interfaces:**

- Consumes: `createWecomAdapter`/`WecomAdapterDeps`（Task 5）、`createWecomApi`（Task 3）、`parseWecomEnv`/`WecomConfig`（Task 2）。
- Produces: `ServerConfig.wecom?: { config: WecomConfig; cwd; provider; model }`。

- [ ] **Step 1: 改 `server.ts` 导入**

顶部加：

```ts
import { createWecomAdapter } from './wecom/adapter.js'
import { createWecomApi } from './wecom/api.js'
import type { WecomConfig } from './wecom/types.js'
```

- [ ] **Step 2: `ServerConfig` 加字段**

在 `telegram?: { config: TelegramConfig; cwd: string; provider: string; model: string }` 之后加：

```ts
  wecom?: { config: WecomConfig; cwd: string; provider: string; model: string }
```

- [ ] **Step 3: 解构 + 建 adapter**

`createServer` 的解构列表（`telegram,` 之后）加 `wecom,`。然后在 telegram adapter 创建块之后加：

```ts
// ── 企业微信 remote-control adapter（长连接，无需 webhook 路由）──
const wecomAdapter = wecom
  ? createWecomAdapter(wecom.config, createWecomApi(wecom.config), {
      sm,
      getOrCreateWorker,
      rateLimiter,
      cwd: wecom.cwd,
      provider: wecom.provider,
      model: wecom.model,
    })
  : undefined
wecomAdapter?.start()
```

- [ ] **Step 4: 心跳推送——企微跳过（无代码改动）**

企微长连接的主动推送语义与飞书/Telegram 不同：`aibot_respond_msg` 仅在收到回调后 24h 内可回，主动推 pending goal/schedule 需另用 `aibot_send_msg`（且需用户先有会话交互），与 heartbeat 的「只通知、不行动」语义不匹配。故 spec §4.7 的企微心跳推送**本计划跳过**，留「范围外」待真需求；`startHeartbeat` 仍只有飞书/Telegram 两个分支，企微不新增。

- [ ] **Step 5: 改 `index.ts` 接线**

在 `src/daemon/index.ts` 顶部 import 加：

```ts
import { parseWecomEnv } from './wecom/env.js'
import type { WecomConfig } from './wecom/types.js'
```

在 telegram 接线块之后加：

```ts
// 企业微信 remote-control adapter（env 未配置时跳过）
const wecomConfig = parseWecomEnv()
let wecom: { config: WecomConfig; cwd: string; provider: string; model: string } | undefined
if (wecomConfig) {
  const cfg = loadConfig()
  const provider = cfg.providers.find((p) => p.status !== 'upcoming') ?? cfg.providers[0]
  wecom = {
    config: wecomConfig,
    cwd: process.env.WECOM_CWD || process.cwd(),
    provider: provider?.id ?? 'anthropic',
    model: provider?.models?.[0]?.id ?? 'claude-sonnet-5',
  }
}
```

并把 `createServer({ ... })` 调用里加 `wecom,`（在 `telegram,` 之后）。

- [ ] **Step 6: typecheck + 全量测试**

Run: `cd apps/cli && pnpm typecheck && pnpm test`
Expected: PASS（既有 1714 测试仍绿；daemon 无 wecom env 时 `wecom` 为 `undefined`，行为不变）。

- [ ] **Step 7: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/server.ts apps/cli/src/daemon/index.ts
git commit -m "feat(wecom): wire adapter into daemon server"
```

---

### Task 7: 集成测试（ws-client → adapter → 回发）

**Files:**

- Test: `test/daemon/wecom/integration.test.ts`

**Interfaces:**

- Consumes: `createWecomAdapter`（Task 5）、`startWecomWs`（Task 4）、`createWecomApi` 的形状（Task 3）。

- [ ] **Step 1: 写集成测试（mock WebSocket 推一条消息，验证全链路）**

`test/daemon/wecom/integration.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWecomAdapter } from '../../../src/daemon/wecom/adapter.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

class MockWS {
  static instances: MockWS[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  constructor(_url: string) {
    MockWS.instances.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.onclose?.()
  }
  emitOpen() {
    this.onopen?.()
  }
  emitMessage(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function makeDeps() {
  const processPrompt = vi.fn(async () => {})
  return {
    processPrompt,
    sm: { getOrCreateByExternalUser: vi.fn(() => ({ id: 'sess-1' })) } as any,
    getOrCreateWorker: vi.fn(() => ({
      processPrompt,
      getLastAssistantContent: () => 'done',
    })) as any,
    rateLimiter: { check: vi.fn(() => ({ allowed: true })) } as any,
    cwd: '/tmp',
    provider: 'anthropic',
    model: 'claude',
  }
}

afterEach(() => {
  MockWS.instances = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('wecom 集成（ws-client → adapter → 回发）', () => {
  it('一条消息回调端到端触发 prompt + respond', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWS as any)

    const deps = makeDeps()
    const respond = vi.fn()
    const api = {
      open: () => new MockWS('x'),
      subscribe: vi.fn(),
      ping: vi.fn(),
      respond,
      parseMessage: (f: any) =>
        f.cmd === 'aibot_msg_callback'
          ? { userId: 'alice', chatId: 'c1', msgId: 'm1', text: f.body.content }
          : null,
      isDisconnected: (f: any) => f.cmd === 'disconnected_event',
      attach: vi.fn(),
    } as any

    const adapter = createWecomAdapter(
      { botId: 'b', botSecret: 's', allowedUserIds: ['alice'] },
      api,
      deps,
    )
    const stop = adapter.start()
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    ws.emitMessage({ cmd: 'aibot_msg_callback', body: { content: 'hi' } })

    await vi.waitFor(() => expect(deps.processPrompt).toHaveBeenCalledWith('hi'))
    stop()
  })
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/wecom/integration.test.ts`
Expected: PASS（`vi.waitFor` 轮询直到 `processPrompt('hi')` 被调）。

- [ ] **Step 3: 全量回归**

Run: `cd apps/cli && pnpm test`
Expected: 1714 + 新增 ~25 全绿。

- [ ] **Step 4: Commit（用户授权后）**

```bash
git add apps/cli/test/daemon/wecom/integration.test.ts
git commit -m "test(wecom): add ws-client→adapter→reply integration test"
```

---

## 已知 Deferral（不在本计划范围）

- **企微主动推送（`aibot_send_msg`）**：企微长连接的「主动推 pending goal/schedule」需 `aibot_send_msg` 命令且用户先有会话交互，与飞书/Telegram 的「只通知」语义不匹配。spec §4.7 提了心跳推送，但实现语义不成立，MVP 跳过（见 Task 6 Step 4 注），留「范围外」待真需求。
- **响应内容过滤（NSFW/PII）**：spec §六安全模型列出，但飞书/Telegram 实现同样未落地，本轮镜像、也不做。要做需独立内容过滤模块，单独立项。
- **群聊 / 图片文件收发 / 流式回传**：spec §九范围外。

## 验证清单（全部任务完成后）

- [ ] `cd apps/cli && pnpm typecheck` 干净
- [ ] `cd apps/cli && pnpm test` 全绿（1714 + 新增 wecom 测试）
- [ ] 无 `WECOM_BOT_ID`/`WECOM_BOT_SECRET` 时 `mipham daemon` 启动不报错（wecom 未启用）
- [ ] 配置 `WECOM_BOT_ID` + `WECOM_BOT_SECRET` + `WECOM_ALLOWED_USER_IDS` 后，真实企微单聊机器人发消息能收到回复（人工验收，需真实 Bot ID+Secret）
