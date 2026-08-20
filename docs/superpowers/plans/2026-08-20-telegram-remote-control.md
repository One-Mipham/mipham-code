# Telegram Bot 远程控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Mipham Code daemon 加 Telegram 远程控制：用户 Telegram 发消息，daemon 长轮询拉取、跑会话、回传结果。

**Architecture:** 在 daemon 内新增 `src/daemon/telegram/` 模块（types/env/api/poller/adapter），镜像现有 `feishu/` 模式；长轮询 `getUpdates`（裸 fetch，零依赖）驱动，会话映射泛化为 `getOrCreateByExternalUser(channel, userId)`，复用 SessionManager/WorkerPool/RateLimiter。

**Tech Stack:** TypeScript strict + ESM（`.js` 导入后缀，同 daemon 现有约定）；Bun/Node 原生 `fetch`；Vitest 3；SQLite（daemon 现用）。

**Spec:** `docs/superpowers/specs/2026-08-20-telegram-remote-control-design.md`

## Global Constraints

- 零新增依赖：Telegram 走裸 `fetch`，不引入 `node-telegram-bot-api`。
- ESM 导入必须带 `.js` 后缀（daemon 现有约定，如 `from './api.js'`）。
- 凭据只走 env（`TELEGRAM_BOT_TOKEN`），禁止硬编码/日志。
- fail-closed：缺 `TELEGRAM_BOT_TOKEN` → daemon 不启用 Telegram（返回 `null`）。
- daemon 会话权限 `default`（headless 最小权限），不新增权限模式。
- 提交遵循 CLAUDE.md「禁止自动提交」：每任务末尾的 commit 步骤仅在用户明确授权后执行；未授权则跳过 commit，改动留工作区。
- 测试命令：`cd apps/cli && pnpm test`；单文件 `pnpm test <path>`。

---

## 文件结构

```
src/daemon/telegram/
├── types.ts          TelegramConfig + TelegramMessage（纯类型）
├── env.ts            parseTelegramEnv(): fail-closed 环境解析
├── api.ts            createTelegramApi(): getUpdates / sendText（裸 fetch）
├── poller.ts         extractTextMessage / nextOffset / nextBackoff（纯函数）+ startTelegramPoller（薄循环）
└── adapter.ts        createTelegramAdapter(): 白名单→限流→会话→processPrompt→回发（镜像 feishu）

src/daemon/session-manager.ts   泛化 getOrCreateByFeishuOpenId → getOrCreateByExternalUser
src/daemon/feishu/adapter.ts    调用点改 getOrCreateByExternalUser('feishu', ...)
src/daemon/server.ts            ServerConfig 加 telegram? + createTelegramAdapter + 心跳 push
src/daemon/index.ts             解析 parseTelegramEnv + 注入 telegram 配置

test/daemon/telegram/           env/api/poller/adapter/integration 五个测试
test/daemon/session-manager.test.ts  泛化方法的测试
```

---

### Task 1: 会话映射泛化 `getOrCreateByExternalUser`

**Files:**

- Modify: `src/daemon/session-manager.ts:26-36`（替换 `getOrCreateByFeishuOpenId`）
- Modify: `src/daemon/feishu/adapter.ts:31`（调用点）
- Modify: `test/daemon/session-manager.test.ts:74-93`（改名 + 加 telegram 用例）

**Interfaces:**

- Consumes: `DaemonDatabase.listSessions()` / `createSession({name, cwd, provider, model})`（现成）。
- Produces: `SessionManager.getOrCreateByExternalUser(channel: string, userId: string, cwd: string, provider: string, model: string): DaemonSession`——后续 Task 5（adapter）依赖此签名。

- [ ] **Step 1: 改实现（先改测试会因方法名消失而编译失败，故先落方法再跑）**

在 `src/daemon/session-manager.ts` 删除 `getOrCreateByFeishuOpenId`，替换为：

```ts
  getOrCreateByExternalUser(
    channel: string,
    userId: string,
    cwd: string,
    provider: string,
    model: string,
  ): DaemonSession {
    const name = `${channel}-${userId}`
    const existing = this.db.listSessions().find((s) => s.name === name && s.status !== 'closed')
    if (existing) return existing
    return this.db.createSession({ name, cwd, provider, model })
  }
```

- [ ] **Step 2: 改飞书调用点**

`src/daemon/feishu/adapter.ts` 第 31-36 行，把：

```ts
const session = deps.sm.getOrCreateByFeishuOpenId(msg.openId, deps.cwd, deps.provider, deps.model)
```

改为：

```ts
const session = deps.sm.getOrCreateByExternalUser(
  'feishu',
  msg.openId,
  deps.cwd,
  deps.provider,
  deps.model,
)
```

- [ ] **Step 3: 更新测试**

`test/daemon/session-manager.test.ts` 第 74-93 行两个用例改为：

```ts
it('getOrCreateByExternalUser 复用同名非 closed 会话', () => {
  const db = new DaemonDatabase(':memory:')
  db.init()
  const sm = new SessionManager(db)
  const s1 = sm.getOrCreateByExternalUser('feishu', 'ou_1', '/tmp', 'anthropic', 'claude')
  const s2 = sm.getOrCreateByExternalUser('feishu', 'ou_1', '/tmp', 'anthropic', 'claude')
  expect(s2.id).toBe(s1.id)
  expect(s2.name).toBe('feishu-ou_1')
  db.close()
})

it('getOrCreateByExternalUser 为不同 channel/userId 建独立会话', () => {
  const db = new DaemonDatabase(':memory:')
  db.init()
  const sm = new SessionManager(db)
  const a = sm.getOrCreateByExternalUser('feishu', 'ou_a', '/tmp', 'anthropic', 'claude')
  const b = sm.getOrCreateByExternalUser('telegram', '111', '/tmp', 'anthropic', 'claude')
  expect(b.id).not.toBe(a.id)
  expect(b.name).toBe('telegram-111')
  db.close()
})
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/cli && pnpm test test/daemon/session-manager.test.ts test/daemon/feishu/adapter.test.ts`
Expected: PASS（飞书 adapter 测试未改断言，仅改调用点，应仍绿）。

- [ ] **Step 5: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/session-manager.ts apps/cli/src/daemon/feishu/adapter.ts apps/cli/test/daemon/session-manager.test.ts
git commit -m "refactor(daemon): generalize session mapping to getOrCreateByExternalUser"
```

---

### Task 2: `telegram/types.ts` + `telegram/env.ts`

**Files:**

- Create: `src/daemon/telegram/types.ts`
- Create: `src/daemon/telegram/env.ts`
- Test: `test/daemon/telegram/env.test.ts`

**Interfaces:**

- Consumes: 无。
- Produces: `TelegramConfig { botToken: string; allowedChatIds: string[] }`、`TelegramMessage { chatId: string; messageId: number; text: string }`、`parseTelegramEnv(): TelegramConfig | null`——Task 3/5/6 依赖。

- [ ] **Step 1: 写失败测试**

`test/daemon/telegram/env.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { parseTelegramEnv } from '../../../src/daemon/telegram/env.js'

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_ALLOWED_CHAT_IDS
})

describe('parseTelegramEnv', () => {
  it('缺 botToken → null（fail-closed）', () => {
    expect(parseTelegramEnv()).toBeNull()
  })

  it('有 botToken 无白名单 → 空数组', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc'
    expect(parseTelegramEnv()).toEqual({ botToken: '123:abc', allowedChatIds: [] })
  })

  it('白名单逗号分隔 trim + 过滤空项', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc'
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = ' 111 , 222 ,,  '
    expect(parseTelegramEnv()!.allowedChatIds).toEqual(['111', '222'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/daemon/telegram/env.test.ts`
Expected: FAIL（`Cannot find module .../telegram/env.js`）。

- [ ] **Step 3: 实现**

`src/daemon/telegram/types.ts`：

```ts
export interface TelegramConfig {
  botToken: string
  allowedChatIds: string[]
}

export interface TelegramMessage {
  chatId: string
  messageId: number
  text: string
}
```

`src/daemon/telegram/env.ts`：

```ts
import type { TelegramConfig } from './types.js'

/** fail-closed：缺 botToken → null（daemon 不启用 Telegram）。 */
export function parseTelegramEnv(): TelegramConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return null
  return {
    botToken,
    allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/telegram/env.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/telegram/types.ts apps/cli/src/daemon/telegram/env.ts apps/cli/test/daemon/telegram/env.test.ts
git commit -m "feat(telegram): add types + fail-closed env parsing"
```

---

### Task 3: `telegram/api.ts`（裸 fetch）

**Files:**

- Create: `src/daemon/telegram/api.ts`
- Test: `test/daemon/telegram/api.test.ts`

**Interfaces:**

- Consumes: `TelegramConfig`（Task 2）。
- Produces: `createTelegramApi(config): TelegramApi`，其中 `TelegramApi { getUpdates(offset: number, timeoutSeconds: number): Promise<Array<{ update_id: number; message?: unknown }>>; sendText(chatId: string, text: string): Promise<void> }`——Task 4/6 依赖。

- [ ] **Step 1: 写失败测试**

`test/daemon/telegram/api.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createTelegramApi } from '../../../src/daemon/telegram/api.js'

const fetchMock = vi.fn()
afterEach(() => vi.unstubAllGlobals())

function stubFetch(json: unknown, ok = true) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(json), { status: ok ? 200 : 500 }))
  vi.stubGlobal('fetch', fetchMock)
}

describe('createTelegramApi', () => {
  it('getUpdates 构造正确 URL（token/method/offset/timeout）', async () => {
    stubFetch({ ok: true, result: [{ update_id: 7 }] })
    const api = createTelegramApi({ botToken: '123:abc', allowedChatIds: [] })
    await api.getUpdates(5, 30)
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/bot123:abc/getUpdates')
    expect(url).toContain('offset=5')
    expect(url).toContain('timeout=30')
  })

  it('getUpdates 返回 result 数组', async () => {
    stubFetch({ ok: true, result: [{ update_id: 7 }] })
    const api = createTelegramApi({ botToken: '123:abc', allowedChatIds: [] })
    await expect(api.getUpdates(0, 30)).resolves.toEqual([{ update_id: 7 }])
  })

  it('sendText POST JSON body { chat_id, text }', async () => {
    stubFetch({ ok: true, result: {} })
    const api = createTelegramApi({ botToken: '123:abc', allowedChatIds: [] })
    await api.sendText('111', 'hi')
    const [, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ chat_id: '111', text: 'hi' })
  })

  it('非 ok 响应 → 抛错', async () => {
    stubFetch({ ok: false, description: 'Unauthorized' }, false)
    const api = createTelegramApi({ botToken: '123:abc', allowedChatIds: [] })
    await expect(api.getUpdates(0, 30)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/daemon/telegram/api.test.ts`
Expected: FAIL（`Cannot find module .../telegram/api.js`）。

- [ ] **Step 3: 实现**

`src/daemon/telegram/api.ts`：

```ts
import type { TelegramConfig } from './types.js'

export interface TelegramApi {
  getUpdates(
    offset: number,
    timeoutSeconds: number,
  ): Promise<Array<{ update_id: number; message?: unknown }>>
  sendText(chatId: string, text: string): Promise<void>
}

/** 裸 fetch 直连 Telegram Bot API，零依赖。 */
export function createTelegramApi(config: TelegramConfig): TelegramApi {
  const base = `https://api.telegram.org/bot${config.botToken}`
  return {
    async getUpdates(offset, timeoutSeconds) {
      const url =
        `${base}/getUpdates?offset=${offset}&timeout=${timeoutSeconds}` +
        `&limit=100&allowed_updates=%5B%22message%22%5D`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`getUpdates ${res.status}`)
      const data = (await res.json()) as {
        ok: boolean
        result?: Array<{ update_id: number; message?: unknown }>
      }
      return data.result ?? []
    },
    async sendText(chatId, text) {
      const res = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      })
      if (!res.ok) throw new Error(`sendMessage ${res.status}`)
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/telegram/api.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/telegram/api.ts apps/cli/test/daemon/telegram/api.test.ts
git commit -m "feat(telegram): add raw-fetch Bot API client"
```

---

### Task 4: `telegram/poller.ts`（长轮询循环）

**Files:**

- Create: `src/daemon/telegram/poller.ts`
- Test: `test/daemon/telegram/poller.test.ts`

**Interfaces:**

- Consumes: `TelegramApi`（Task 3）、`TelegramMessage`（Task 2）。
- Produces: `extractTextMessage(update: unknown): TelegramMessage | null`、`nextOffset(updates: Array<{ update_id?: number }>, prevOffset: number): number`、`nextBackoff(currentMs: number): number`、`startTelegramPoller(api, onMessage, opts?): () => void`——Task 5 依赖。

- [ ] **Step 1: 写失败测试（纯函数）**

`test/daemon/telegram/poller.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { extractTextMessage, nextOffset, nextBackoff } from '../../../src/daemon/telegram/poller.js'

describe('extractTextMessage', () => {
  it('text 消息 → TelegramMessage', () => {
    const m = extractTextMessage({ message: { chat: { id: 111 }, message_id: 5, text: 'hi' } })
    expect(m).toEqual({ chatId: '111', messageId: 5, text: 'hi' })
  })

  it('非 text / 无 message → null', () => {
    expect(extractTextMessage({ message: { chat: { id: 111 }, message_id: 5 } })).toBeNull()
    expect(extractTextMessage({ update_id: 1 })).toBeNull()
    expect(extractTextMessage({})).toBeNull()
  })

  it('chat.id 字符串化（64 位安全）', () => {
    const m = extractTextMessage({ message: { chat: { id: 999 }, text: 'x' } })
    expect(m!.chatId).toBe('999')
  })
})

describe('nextOffset', () => {
  it('空列表沿用 prev', () => expect(nextOffset([], 5)).toBe(5))
  it('返回最大 update_id + 1', () =>
    expect(nextOffset([{ update_id: 3 }, { update_id: 7 }], 2)).toBe(8))
})

describe('nextBackoff', () => {
  it('指数退避', () => expect(nextBackoff(1000)).toBe(2000))
  it('封顶 30s', () => expect(nextBackoff(20000)).toBe(30000))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/daemon/telegram/poller.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/daemon/telegram/poller.ts`：

```ts
import type { TelegramApi } from './api.js'
import type { TelegramMessage } from './types.js'

/** 从 update 提取文本消息；非文本/缺 message → null。chat.id 统一字符串化（64 位安全）。 */
export function extractTextMessage(update: unknown): TelegramMessage | null {
  const msg = (
    update as { message?: { chat?: { id?: number | string }; message_id?: number; text?: string } }
  )?.message
  if (!msg?.text || msg.chat?.id == null) return null
  return { chatId: String(msg.chat.id), messageId: msg.message_id ?? 0, text: msg.text }
}

/** 推进 offset：最大 update_id + 1；空列表沿用 prev。 */
export function nextOffset(updates: Array<{ update_id?: number }>, prevOffset: number): number {
  if (updates.length === 0) return prevOffset
  return Math.max(...updates.map((u) => u.update_id ?? prevOffset)) + 1
}

/** 指数退避，封顶 30s。 */
export function nextBackoff(currentMs: number): number {
  return Math.min(currentMs * 2, 30_000)
}

/** 长轮询循环（unref 不阻退出）。返回 stop 函数。循环行为由 Task 7 集成测试覆盖。 */
export function startTelegramPoller(
  api: TelegramApi,
  onMessage: (msg: TelegramMessage) => Promise<void>,
  opts?: { pollTimeoutSeconds?: number },
): () => void {
  let offset = 0
  let backoffMs = 1000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  async function loop() {
    if (stopped) return
    try {
      const updates = await api.getUpdates(offset, opts?.pollTimeoutSeconds ?? 30)
      for (const u of updates) {
        const msg = extractTextMessage(u)
        if (msg) {
          try {
            await onMessage(msg)
          } catch {
            /* 单条失败不中断轮询 */
          }
        }
      }
      offset = nextOffset(updates, offset)
      backoffMs = 1000
    } catch {
      backoffMs = nextBackoff(backoffMs)
    }
    if (stopped) return
    timer = setTimeout(loop, backoffMs)
    ;(timer as { unref?: () => void }).unref?.()
  }

  void loop()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/telegram/poller.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/telegram/poller.ts apps/cli/test/daemon/telegram/poller.test.ts
git commit -m "feat(telegram): add long-polling loop + pure helpers"
```

---

### Task 5: `telegram/adapter.ts`（业务编排）

**Files:**

- Create: `src/daemon/telegram/adapter.ts`
- Test: `test/daemon/telegram/adapter.test.ts`

**Interfaces:**

- Consumes: `TelegramConfig`/`TelegramMessage`（Task 2）、`TelegramApi`（Task 3）、`startTelegramPoller`（Task 4）、`getOrCreateByExternalUser`（Task 1）。
- Produces: `createTelegramAdapter(config, api, deps): TelegramAdapter`，其中 `TelegramAdapter { start(): () => void; handleMessage(msg: TelegramMessage): Promise<void>; isAllowed(chatId: string): boolean }`；`TelegramAdapterDeps { sm: SessionManager; getOrCreateWorker: (id) => SessionWorker | null; rateLimiter: RateLimiter; cwd; provider; model }`——Task 6 依赖。

- [ ] **Step 1: 写失败测试（镜像 feishu adapter 测试）**

`test/daemon/telegram/adapter.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { createTelegramAdapter } from '../../../src/daemon/telegram/adapter.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

const config = { botToken: '123:abc', allowedChatIds: ['111'] }

function makeDeps() {
  const processPrompt = vi.fn(async () => {})
  return {
    processPrompt,
    sm: {
      getOrCreateByExternalUser: vi.fn(() => ({ id: 'sess-1', name: 'telegram-111' })),
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
    getUpdates: vi.fn(() => new Promise(() => {})), // 默认挂起，供 start() 测试
    sendText: vi.fn(async () => {}),
  } as any
}

describe('createTelegramAdapter', () => {
  it('白名单 miss → 不跑 prompt 不回发', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createTelegramAdapter({ ...config, allowedChatIds: [] }, api, deps)
    await a.handleMessage({ chatId: '111', messageId: 1, text: 'hi' })
    expect(deps.processPrompt).not.toHaveBeenCalled()
    expect(api.sendText).not.toHaveBeenCalled()
  })

  it('白名单 hit → processPrompt 一次 + 回发最终内容', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createTelegramAdapter(config, api, deps)
    await a.handleMessage({ chatId: '111', messageId: 1, text: 'hi' })
    expect(deps.processPrompt).toHaveBeenCalledWith('hi')
    expect(api.sendText).toHaveBeenCalledWith('111', '完成！')
  })

  it('会话映射用 telegram channel', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createTelegramAdapter(config, api, deps)
    await a.handleMessage({ chatId: '111', messageId: 1, text: 'hi' })
    expect(deps.sm.getOrCreateByExternalUser).toHaveBeenCalledWith(
      'telegram',
      '111',
      '/tmp',
      'anthropic',
      'claude',
    )
  })

  it('worker null → 回发「初始化失败」', async () => {
    const deps = makeDeps()
    ;(deps.getOrCreateWorker as any).mockReturnValue(null)
    const api = makeApi()
    const a = createTelegramAdapter(config, api, deps)
    await a.handleMessage({ chatId: '111', messageId: 1, text: 'hi' })
    expect(api.sendText).toHaveBeenCalledWith('111', '（会话初始化失败，请稍后重试）')
  })

  it('回发失败 → 不 rethrow，prompt 只跑一次', async () => {
    const deps = makeDeps()
    const api = makeApi()
    api.sendText.mockRejectedValue(new Error('send failed'))
    const a = createTelegramAdapter(config, api, deps)
    await expect(
      a.handleMessage({ chatId: '111', messageId: 1, text: 'hi' }),
    ).resolves.toBeUndefined()
    expect(deps.processPrompt).toHaveBeenCalledTimes(1)
  })

  it('start 幂等：重复调用返回同一 stop', () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createTelegramAdapter(config, api, deps)
    const s1 = a.start()
    const s2 = a.start()
    expect(s1).toBe(s2)
    s1()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/daemon/telegram/adapter.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/daemon/telegram/adapter.ts`：

```ts
import type { TelegramApi } from './api.js'
import type { TelegramConfig, TelegramMessage } from './types.js'
import type { SessionManager } from '../session-manager'
import type { SessionWorker } from '../session-worker'
import type { RateLimiter } from '../rate-limiter'
import { startTelegramPoller } from './poller.js'

export interface TelegramAdapterDeps {
  sm: SessionManager
  getOrCreateWorker: (sessionId: string) => SessionWorker | null
  rateLimiter: RateLimiter
  cwd: string
  provider: string
  model: string
}

export interface TelegramAdapter {
  start(): () => void
  handleMessage(msg: TelegramMessage): Promise<void>
  isAllowed(chatId: string): boolean
}

export function createTelegramAdapter(
  config: TelegramConfig,
  api: TelegramApi,
  deps: TelegramAdapterDeps,
): TelegramAdapter {
  const allowed = new Set(config.allowedChatIds)
  let stopPoller: (() => void) | null = null

  async function handleMessage(msg: TelegramMessage): Promise<void> {
    try {
      if (!allowed.has(msg.chatId)) return
      if (!deps.rateLimiter.check(`telegram:${msg.chatId}`).allowed) return

      const session = deps.sm.getOrCreateByExternalUser(
        'telegram',
        msg.chatId,
        deps.cwd,
        deps.provider,
        deps.model,
      )
      const worker = deps.getOrCreateWorker(session.id)
      if (!worker) {
        await api.sendText(msg.chatId, '（会话初始化失败，请稍后重试）')
        return
      }
      await worker.processPrompt(msg.text)
      const result = worker.getLastAssistantContent()
      await api.sendText(msg.chatId, result ? result.slice(0, 4096) : '（无回复）')
    } catch (err) {
      console.error('[telegram] message handling failed:', err)
      try {
        await api.sendText(msg.chatId, '（处理失败，请稍后重试）')
      } catch {
        /* 忽略回送失败，不 rethrow */
      }
    }
  }

  return {
    handleMessage,
    isAllowed: (chatId) => allowed.has(chatId),
    start() {
      if (stopPoller) return stopPoller
      stopPoller = startTelegramPoller(api, handleMessage)
      return stopPoller
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/telegram/adapter.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/telegram/adapter.ts apps/cli/test/daemon/telegram/adapter.test.ts
git commit -m "feat(telegram): add adapter — whitelist/session/prompt/reply"
```

---

### Task 6: `server.ts` + `index.ts` 接线 + 心跳

**Files:**

- Modify: `src/daemon/server.ts`（ServerConfig 加 `telegram?`、建 adapter + 心跳 push）
- Modify: `src/daemon/index.ts`（解析 `parseTelegramEnv` + 注入 `telegram`）

**Interfaces:**

- Consumes: `createTelegramAdapter`/`TelegramAdapterDeps`（Task 5）、`createTelegramApi`（Task 3）、`parseTelegramEnv`/`TelegramConfig`（Task 2）。
- Produces: `ServerConfig.telegram?: { config: TelegramConfig; cwd; provider; model }`。

- [ ] **Step 1: 改 `server.ts` 导入**

顶部加：

```ts
import { createTelegramAdapter } from './telegram/adapter.js'
import { createTelegramApi } from './telegram/api.js'
import type { TelegramConfig } from './telegram/types.js'
```

- [ ] **Step 2: `ServerConfig` 加字段**

在 `feishu?: { config: FeishuConfig; cwd: string; provider: string; model: string }` 之后加：

```ts
  telegram?: { config: TelegramConfig; cwd: string; provider: string; model: string }
```

- [ ] **Step 3: 解构 + 建 adapter**

`createServer` 的解构列表（`feishu,` 之后）加 `telegram,`。然后在 feishu adapter 创建块之后加：

```ts
// ── Telegram remote-control adapter（长轮询，无需 webhook 路由）──
const telegramAdapter = telegram
  ? createTelegramAdapter(telegram.config, createTelegramApi(telegram.config), {
      sm,
      getOrCreateWorker,
      rateLimiter,
      cwd: telegram.cwd,
      provider: telegram.provider,
      model: telegram.model,
    })
  : undefined
telegramAdapter?.start()
```

- [ ] **Step 4: 心跳 push 抽 source + 加 Telegram**

把现有心跳块：

```ts
if (feishu) {
  const feishuApi = createFeishuApi(feishu.config)
  startHeartbeat({
    source: {
      listGoals: () => sm.listSessions().flatMap((s) => goalManager.getGoals(s.id)),
      listSchedules: () => sm.listSessions().flatMap((s) => scheduleManager.getSchedules(s.id)),
    },
    push: (message) => {
      for (const openId of feishu.config.allowedOpenIds) {
        void feishuApi.sendText(openId, message).catch(() => {})
      }
    },
  })
}
```

改为：

```ts
const heartbeatSource = {
  listGoals: () => sm.listSessions().flatMap((s) => goalManager.getGoals(s.id)),
  listSchedules: () => sm.listSessions().flatMap((s) => scheduleManager.getSchedules(s.id)),
}
if (feishu) {
  const feishuApi = createFeishuApi(feishu.config)
  startHeartbeat({
    source: heartbeatSource,
    push: (message) => {
      for (const openId of feishu.config.allowedOpenIds) {
        void feishuApi.sendText(openId, message).catch(() => {})
      }
    },
  })
}
if (telegram) {
  const telegramApi = createTelegramApi(telegram.config)
  startHeartbeat({
    source: heartbeatSource,
    push: (message) => {
      for (const chatId of telegram.config.allowedChatIds) {
        void telegramApi.sendText(chatId, message).catch(() => {})
      }
    },
  })
}
```

- [ ] **Step 5: 改 `index.ts` 接线**

在 `src/daemon/index.ts` 顶部 import 加：

```ts
import { parseTelegramEnv } from './telegram/env.js'
import type { TelegramConfig } from './telegram/types.js'
```

在 feishu 接线块（`if (feishuConfig) { ... }`，约 169-182 行）之后加：

```ts
// Telegram remote-control adapter（env 未配置时跳过）
const telegramConfig = parseTelegramEnv()
let telegram: { config: TelegramConfig; cwd: string; provider: string; model: string } | undefined
if (telegramConfig) {
  const cfg = loadConfig()
  const provider = cfg.providers.find((p) => p.status !== 'upcoming') ?? cfg.providers[0]
  telegram = {
    config: telegramConfig,
    cwd: process.env.TELEGRAM_CWD || process.cwd(),
    provider: provider?.id ?? 'anthropic',
    model: provider?.models?.[0]?.id ?? 'claude-sonnet-5',
  }
}
```

并把 `createServer({ ... })` 调用里加 `telegram,`（在 `feishu,` 之后）。

- [ ] **Step 6: typecheck + 全量测试**

Run: `cd apps/cli && pnpm typecheck && pnpm test`
Expected: PASS（既有 1650 测试仍绿；daemon 无 telegram env 时 `telegram` 为 `undefined`，行为不变）。

- [ ] **Step 7: Commit（用户授权后）**

```bash
git add apps/cli/src/daemon/server.ts apps/cli/src/daemon/index.ts
git commit -m "feat(telegram): wire adapter into daemon server + heartbeat"
```

---

### Task 7: 集成测试（poller → adapter → 回发）

**Files:**

- Test: `test/daemon/telegram/integration.test.ts`

**Interfaces:**

- Consumes: `createTelegramAdapter`（Task 5）、`startTelegramPoller`（Task 4）、`createTelegramApi` 的形状（Task 3）。

- [ ] **Step 1: 写集成测试（mock api 推一条 update，验证全链路）**

`test/daemon/telegram/integration.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { createTelegramAdapter } from '../../../src/daemon/telegram/adapter.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

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

describe('telegram 集成（poller → adapter → 回发）', () => {
  it('一条 text update 端到端触发 prompt + 回发', async () => {
    const deps = makeDeps()
    const sendText = vi.fn(async () => {})
    // getUpdates 首次返回一条，之后挂起（模拟长轮询阻塞）
    let calls = 0
    const api = {
      getUpdates: vi.fn(() => {
        calls++
        if (calls === 1) {
          return Promise.resolve([
            { update_id: 1, message: { chat: { id: 111 }, message_id: 5, text: 'hi' } },
          ])
        }
        return new Promise(() => {}) // 挂起
      }),
      sendText,
    } as any

    const adapter = createTelegramAdapter({ botToken: 'x', allowedChatIds: ['111'] }, api, deps)
    const stop = adapter.start()

    // 等首个 loop 完成（getUpdates 已 resolve + handleMessage 已 await）
    await vi.waitFor(() => expect(deps.processPrompt).toHaveBeenCalledWith('hi'))
    expect(sendText).toHaveBeenCalledWith('111', 'done')
    stop()
  })
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/daemon/telegram/integration.test.ts`
Expected: PASS（`vi.waitFor` 轮询直到 `processPrompt('hi')` 被调）。

- [ ] **Step 3: 全量回归**

Run: `cd apps/cli && pnpm test`
Expected: 1650 + 新增 ~15 全绿。

- [ ] **Step 4: Commit（用户授权后）**

```bash
git add apps/cli/test/daemon/telegram/integration.test.ts
git commit -m "test(telegram): add poller→adapter→reply integration test"
```

---

## 已知 Deferral（不在本计划范围）

- **响应内容过滤（NSFW/PII）**：spec §六安全模型列出，但飞书实现同样未落地（飞书 spec 列了、代码没做），Telegram 镜像飞书、本轮也不做。要做需独立的内容过滤模块（regex 或 LLM 裁判），单独立项。

## 验证清单（全部任务完成后）

- [ ] `cd apps/cli && pnpm typecheck` 干净
- [ ] `cd apps/cli && pnpm test` 全绿（1650 + 新增 telegram 测试）
- [ ] 无 `TELEGRAM_BOT_TOKEN` 时 `mipham daemon` 启动不报错（telegram 未启用）
- [ ] 配置 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHAT_IDS` 后，真实 Telegram 发消息能收到回复（人工验收，需真实 token）
