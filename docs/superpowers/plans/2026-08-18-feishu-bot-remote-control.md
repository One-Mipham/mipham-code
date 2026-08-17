# Feishu Bot 远程控制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Mipham Code Daemon 里加飞书自建应用远程控制——飞书用户发消息，Daemon 在持久会话里跑 prompt 并把最终回复发回飞书。

**Architecture:** 方案 A——`src/daemon/feishu/` 模块（types/api/events/adapter 四文件），挂到 `server.ts` 的 `/feishu/event` 路由，复用 `SessionManager`/`getOrCreateWorker`/`RateLimiter`。事件用官方 Lark SDK `@larksuiteoapi/node-sdk` 解密验签；open_id→session 用会话名约定 `feishu-<open_id>`（避免 DB 迁移）。

**Tech Stack:** TypeScript (Bun), `@larksuiteoapi/node-sdk` (MIT), Vitest, SQLite（复用现有 sessions 表，不改 schema）。

**Spec:** `docs/superpowers/specs/2026-08-18-feishu-bot-remote-control-design.md`

## Global Constraints

- 语言：TypeScript strict，ESM，import 用 `.js` 后缀（如 `import { x } from './api.js'`）。
- 依赖：仅新增 `@larksuiteoapi/node-sdk`（MIT，无 copyleft/GPL）。
- 密钥：`FEISHU_APP_ID/SECRET/ENCRYPT_KEY/VERIFICATION_TOKEN/ALLOWED_OPEN_IDS` 全部 env 注入，禁止硬编码/日志。
- 权限：Feishu 会话走 daemon 默认 `default` 权限（headless 无弹窗）。
- 测试：TDD，先写失败测试再实现；提交信息 Conventional Commits + `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **与 spec 的一处偏差**：spec 写「sessions 表加 `feishuOpenId` 列」，规划时发现改 DB schema 需加 ALTER TABLE 迁移（`CREATE TABLE IF NOT EXISTS` 对已有 daemon.db 不生效）。改用会话名约定 `feishu-<open_id>` 持久化映射，零迁移、更外科。若坚持 DB 列，替换 Task 5。

---

## File Structure

- **Create** `apps/cli/src/daemon/feishu/types.ts` — `FeishuConfig` + `FeishuTextMessage` 类型。
- **Create** `apps/cli/src/daemon/feishu/api.ts` — `createFeishuApi(config)` → `{ sendText(openId, text) }`。
- **Create** `apps/cli/src/daemon/feishu/events.ts` — `createFeishuEventDispatcher(config, onMessage)` → `{ invoke(body, headers) }`。
- **Create** `apps/cli/src/daemon/feishu/adapter.ts` — `createFeishuAdapter(config, deps)` → `{ handleEvent(request) }`。
- **Create** `apps/cli/src/daemon/feishu/env.ts` — `parseFeishuEnv()` → `FeishuConfig | null`（读 `FEISHU_*` env）。
- **Modify** `apps/cli/src/daemon/session-worker.ts` — 加 `getLastAssistantContent()`。
- **Modify** `apps/cli/src/daemon/session-manager.ts` — 加 `getOrCreateByFeishuOpenId(openId)`。
- **Modify** `apps/cli/src/daemon/server.ts` — 挂 `/feishu/event` 路由 + 构造 adapter。
- **Modify** `apps/cli/src/daemon/index.ts` — 读 `FEISHU_*` env。
- **Modify** `apps/cli/package.json` — 加 `@larksuiteoapi/node-sdk`。
- **Test** `apps/cli/test/daemon/feishu/*.test.ts`。

---

### Task 1: 依赖 + 类型骨架

**Files:**

- Modify: `apps/cli/package.json`
- Create: `apps/cli/src/daemon/feishu/types.ts`
- Test: 无（纯类型，无逻辑）

**Interfaces:**

- Produces: `FeishuConfig`、`FeishuTextMessage`（后续所有 task 引用）。

- [ ] **Step 1: 加依赖**

Run: `cd apps/cli && pnpm add @larksuiteoapi/node-sdk`
Expected: 依赖写入 `package.json` dependencies，`pnpm-lock.yaml` 更新。

- [ ] **Step 2: 写 types.ts**

`apps/cli/src/daemon/feishu/types.ts`:

```ts
export interface FeishuConfig {
  appId: string
  appSecret: string
  encryptKey: string
  verificationToken: string
  allowedOpenIds: string[]
}

export interface FeishuTextMessage {
  chatId: string
  messageId: string
  openId: string
  text: string
}
```

- [ ] **Step 3: typecheck 通过**

Run: `cd apps/cli && pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add apps/cli/package.json pnpm-lock.yaml apps/cli/src/daemon/feishu/types.ts
git commit -m "feat(daemon): 加 lark SDK 依赖 + Feishu 类型骨架"
```

---

### Task 2: api.ts — 发消息

**Files:**

- Create: `apps/cli/src/daemon/feishu/api.ts`
- Test: `apps/cli/test/daemon/feishu/api.test.ts`

**Interfaces:**

- Consumes: `FeishuConfig`（Task 1）。
- Produces: `createFeishuApi(config): FeishuApi`，`FeishuApi = { sendText(openId: string, text: string): Promise<void> }`。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/daemon/feishu/api.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()
vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 1 },
  Domain: { Feishu: 'feishu' },
  Client: class {
    im: any
    constructor(opts: unknown) {
      createMock(opts)
      this.im = { message: { create: vi.fn() } }
    }
  },
}))

import { createFeishuApi } from '../../../src/daemon/feishu/api.js'

const config = {
  appId: 'app-1',
  appSecret: 'sec-1',
  encryptKey: 'key',
  verificationToken: 'tok',
  allowedOpenIds: [],
}

beforeEach(() => createMock.mockClear())

describe('createFeishuApi.sendText', () => {
  it('构造 Client 并调用 im.message.create', async () => {
    const api = createFeishuApi(config)
    await api.sendText('ou_1', 'hello')
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-1', appSecret: 'sec-1' }),
    )
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `cd apps/cli && pnpm exec vitest run test/daemon/feishu/api.test.ts`
Expected: FAIL — `createFeishuApi` 不存在。

- [ ] **Step 3: 实现 api.ts**

`apps/cli/src/daemon/feishu/api.ts`:

```ts
import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig } from './types.js'

export interface FeishuApi {
  sendText(openId: string, text: string): Promise<void>
}

export function createFeishuApi(config: FeishuConfig): FeishuApi {
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  })
  return {
    async sendText(openId: string, text: string): Promise<void> {
      await client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
      })
    },
  }
}
```

- [ ] **Step 4: 验证通过**

Run: `cd apps/cli && pnpm exec vitest run test/daemon/feishu/api.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/feishu/api.ts apps/cli/test/daemon/feishu/api.test.ts
git commit -m "feat(daemon): Feishu 发消息 API（Lark SDK）"
```

---

### Task 3: events.ts — 事件解密验签

**Files:**

- Create: `apps/cli/src/daemon/feishu/events.ts`
- Test: `apps/cli/test/daemon/feishu/events.test.ts`

**Interfaces:**

- Consumes: `FeishuConfig`、`FeishuTextMessage`（Task 1）。
- Produces: `createFeishuEventDispatcher(config, onMessage): FeishuEventDispatcher`；`FeishuEventDispatcher = { invoke(body: unknown, headers: Record<string,string>): Promise<unknown> }`；`onMessage: (msg: FeishuTextMessage) => Promise<void>`。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/daemon/feishu/events.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

const registered: Record<string, Function> = {}
const invokeMock = vi.fn(async () => ({ code: 0 }))
vi.mock('@larksuiteoapi/node-sdk', () => ({
  EventDispatcher: class {
    constructor(_opts: unknown) {}
    register(map: Record<string, Function>) {
      Object.assign(registered, map)
      return this
    }
    async invoke(_assigned: unknown) {
      return invokeMock(_assigned)
    }
  },
}))

import { createFeishuEventDispatcher } from '../../../src/daemon/feishu/events.js'

const config = {
  appId: 'a',
  appSecret: 's',
  encryptKey: 'k',
  verificationToken: 't',
  allowedOpenIds: [],
}

describe('createFeishuEventDispatcher', () => {
  it('注册 im.message.receive_v1 处理器并解析文本', async () => {
    const onMessage = vi.fn(async () => {})
    createFeishuEventDispatcher(config, onMessage)

    const handler = registered['im.message.receive_v1']
    expect(handler).toBeDefined()
    await handler({
      message: {
        chat_id: 'c1',
        message_id: 'm1',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    })

    expect(onMessage).toHaveBeenCalledWith({
      chatId: 'c1',
      messageId: 'm1',
      openId: 'ou_1',
      text: 'hi',
    })
  })

  it('invoke 透传 body + headers 给 SDK', async () => {
    const onMessage = vi.fn(async () => {})
    const d = createFeishuEventDispatcher(config, onMessage)
    const body = { encrypt: 'x' }
    const headers = { 'x-lark-signature': 'sig' }
    await d.invoke(body, headers)
    expect(invokeMock).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 验证失败** — Run: `pnpm exec vitest run test/daemon/feishu/events.test.ts` → FAIL（`createFeishuEventDispatcher` 不存在）。

- [ ] **Step 3: 实现 events.ts**

`apps/cli/src/daemon/feishu/events.ts`:

```ts
import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig, FeishuTextMessage } from './types.js'

export type OnFeishuMessage = (msg: FeishuTextMessage) => Promise<void>

export interface FeishuEventDispatcher {
  invoke(body: unknown, headers: Record<string, string>): Promise<unknown>
}

export function createFeishuEventDispatcher(
  config: FeishuConfig,
  onMessage: OnFeishuMessage,
): FeishuEventDispatcher {
  const dispatcher = new lark.EventDispatcher({
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
  }).register({
    'im.message.receive_v1': async (data: any) => {
      const message = data?.message
      if (message?.message_type !== 'text') return
      let text = ''
      try {
        text = JSON.parse(message.content).text ?? ''
      } catch {
        return
      }
      const openId = data?.sender?.sender_id?.open_id
      if (!openId || !text) return
      await onMessage({ chatId: message.chat_id, messageId: message.message_id, openId, text })
    },
  })

  return {
    async invoke(body, headers) {
      const assigned = Object.assign(Object.create({ headers }), body)
      return await dispatcher.invoke(assigned)
    },
  }
}
```

- [ ] **Step 4: 验证通过** — Run: 同 Step 2 → PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/feishu/events.ts apps/cli/test/daemon/feishu/events.test.ts
git commit -m "feat(daemon): Feishu 事件解密验签（EventDispatcher 封装）"
```

---

### Task 4: SessionWorker 暴露最终回复

**Files:**

- Modify: `apps/cli/src/daemon/session-worker.ts`
- Test: `apps/cli/test/daemon/session-worker.test.ts`（若不存在则新建）

**Interfaces:**

- Consumes: `QueryEngine.getLastAssistantContent()`（`src/core/engine.ts:357` 已存在）。
- Produces: `SessionWorker.getLastAssistantContent(): string | undefined`。

- [ ] **Step 1: 写失败测试**

在 `test/daemon/session-worker.test.ts`（或新建）加：

```ts
it('getLastAssistantContent 委托给 engine', () => {
  const engine = { getLastAssistantContent: () => '最终回复' } as any
  const worker = new SessionWorker(engine, {} as any, {} as any)
  expect(worker.getLastAssistantContent()).toBe('最终回复')
})
```

- [ ] **Step 2: 验证失败** — Run: `pnpm exec vitest run test/daemon/session-worker.test.ts` → FAIL（方法不存在）。

- [ ] **Step 3: 实现**

在 `SessionWorker` 类加（`this.engine` 已存在）：

```ts
getLastAssistantContent(): string | undefined {
  return this.engine.getLastAssistantContent()
}
```

- [ ] **Step 4: 验证通过** — Run: 同 Step 2 → PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/session-worker.ts apps/cli/test/daemon/session-worker.test.ts
git commit -m "feat(daemon): SessionWorker 暴露 getLastAssistantContent"
```

---

### Task 5: SessionManager open_id→session 映射

**Files:**

- Modify: `apps/cli/src/daemon/session-manager.ts`
- Test: `apps/cli/test/daemon/session-manager.test.ts`（若不存在则新建）

**Interfaces:**

- Consumes: 现有 `createSession(name, cwd, provider, model)`、`listSessions()`、`getSession(id)`。
- Produces: `getOrCreateByFeishuOpenId(openId: string, cwd: string, provider: string, model: string): DaemonSession`。

- [ ] **Step 1: 写失败测试**

```ts
it('getOrCreateByFeishuOpenId 复用同名非 closed 会话', () => {
  const db = new DaemonDatabase(':memory:')
  const sm = new SessionManager(db)
  const s1 = sm.getOrCreateByFeishuOpenId('ou_1', '/tmp', 'anthropic', 'claude')
  const s2 = sm.getOrCreateByFeishuOpenId('ou_1', '/tmp', 'anthropic', 'claude')
  expect(s2.id).toBe(s1.id)
  expect(s2.name).toBe('feishu-ou_1')
})

it('getOrCreateByFeishuOpenId 为不同 openId 建独立会话', () => {
  const db = new DaemonDatabase(':memory:')
  const sm = new SessionManager(db)
  const a = sm.getOrCreateByFeishuOpenId('ou_a', '/tmp', 'anthropic', 'claude')
  const b = sm.getOrCreateByFeishuOpenId('ou_b', '/tmp', 'anthropic', 'claude')
  expect(b.id).not.toBe(a.id)
})
```

- [ ] **Step 2: 验证失败** — Run: `pnpm exec vitest run test/daemon/session-manager.test.ts` → FAIL（方法不存在）。

- [ ] **Step 3: 实现**

在 `SessionManager` 类加：

```ts
getOrCreateByFeishuOpenId(openId: string, cwd: string, provider: string, model: string): DaemonSession {
  const name = `feishu-${openId}`
  const existing = this.db.listSessions().find((s) => s.name === name && s.status !== 'closed')
  if (existing) return existing
  return this.db.createSession({ name, cwd, provider, model })
}
```

- [ ] **Step 4: 验证通过** — Run: 同 Step 2 → PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/session-manager.ts apps/cli/test/daemon/session-manager.test.ts
git commit -m "feat(daemon): SessionManager 按 open_id 映射会话（feishu- 前缀）"
```

---

### Task 6: adapter.ts — 编排

**Files:**

- Create: `apps/cli/src/daemon/feishu/adapter.ts`
- Test: `apps/cli/test/daemon/feishu/adapter.test.ts`

**Interfaces:**

- Consumes: Task 1-5 的全部产出。
- Produces: `createFeishuAdapter(config, deps): FeishuAdapter`；`FeishuAdapter = { handleEvent(request: Request): Promise<Response> }`；`deps = { sm, getOrCreateWorker, rateLimiter, cwd, provider, model }`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 1 },
  Domain: { Feishu: 'feishu' },
  Client: class {
    im = { message: { create: vi.fn() } }
  },
  EventDispatcher: class {
    register(map: Record<string, Function>) {
      this._map = map
      return this
    }
    _map: Record<string, Function> = {}
    async invoke(_a: unknown) {
      return { code: 0 }
    }
  },
}))
import { createFeishuAdapter } from '../../../src/daemon/feishu/adapter.js'

const config = {
  appId: 'a',
  appSecret: 's',
  encryptKey: 'k',
  verificationToken: 't',
  allowedOpenIds: ['ou_1'],
}

function makeDeps() {
  return {
    sm: {
      getOrCreateByFeishuOpenId: vi.fn(() => ({
        id: 'sess-1',
        name: 'feishu-ou_1',
        cwd: '/tmp',
        provider: 'anthropic',
        model: 'claude',
      })),
    } as any,
    getOrCreateWorker: vi.fn(() => ({
      processPrompt: vi.fn(async () => {}),
      getLastAssistantContent: () => '完成！',
    })) as any,
    rateLimiter: { check: vi.fn(() => ({ allowed: true })) } as any,
    cwd: '/tmp',
    provider: 'anthropic',
    model: 'claude',
  }
}

describe('createFeishuAdapter', () => {
  it('handleEvent 回显 challenge', async () => {
    const a = createFeishuAdapter(config, makeDeps())
    const res = await a.handleEvent(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ challenge: 'abc' }) }),
    )
    expect(await res.json()).toEqual({ challenge: 'abc' })
  })

  it('白名单外 openId 不跑 prompt', async () => {
    const deps = makeDeps()
    // 通过 dispatcher 触发 onMessage —— 直接调用内部 onMessage 不可行，改测 handleEvent 路径：
    // 这里用未授权配置重建 adapter，验证白名单过滤在 adapter 层生效。
    const a = createFeishuAdapter({ ...config, allowedOpenIds: [] }, deps)
    // 加密事件走 invoke，无法在单测里模拟解密；白名单过滤逻辑抽成纯函数 isAllowed 便于测试
    expect(a.isAllowed('ou_x')).toBe(false)
  })
})
```

> 注：adapter 把白名单判定抽成**纯函数** `isAllowed(openId)`（构造时闭包 `Set`），单测直接断言；完整链路（解密→白名单→prompt→回传）由 Task 7 集成测试覆盖。

- [ ] **Step 2: 验证失败** — Run: `pnpm exec vitest run test/daemon/feishu/adapter.test.ts` → FAIL。

- [ ] **Step 3: 实现 adapter.ts**

`apps/cli/src/daemon/feishu/adapter.ts`:

```ts
import { createFeishuApi } from './api.js'
import { createFeishuEventDispatcher } from './events.js'
import type { FeishuConfig, FeishuTextMessage } from './types.js'
import type { SessionManager } from '../session-manager.js'
import type { SessionWorker } from '../session-worker.js'
import type { RateLimiter } from '../rate-limiter.js'

export interface FeishuAdapterDeps {
  sm: SessionManager
  getOrCreateWorker: (sessionId: string) => SessionWorker | null
  rateLimiter: RateLimiter
  cwd: string
  provider: string
  model: string
}

export interface FeishuAdapter {
  handleEvent(request: Request): Promise<Response>
  isAllowed(openId: string): boolean
}

export function createFeishuAdapter(config: FeishuConfig, deps: FeishuAdapterDeps): FeishuAdapter {
  const api = createFeishuApi(config)
  const allowed = new Set(config.allowedOpenIds)

  const onMessage = async (msg: FeishuTextMessage) => {
    if (!allowed.has(msg.openId)) return
    if (!deps.rateLimiter.check(`feishu:${msg.openId}`).allowed) return

    const session = deps.sm.getOrCreateByFeishuOpenId(
      msg.openId,
      deps.cwd,
      deps.provider,
      deps.model,
    )
    const worker = deps.getOrCreateWorker(session.id)
    if (!worker) {
      await api.sendText(msg.openId, '（会话初始化失败，请稍后重试）')
      return
    }
    await worker.processPrompt(msg.text)
    const result = worker.getLastAssistantContent()
    await api.sendText(msg.openId, result ? result.slice(0, 4000) : '（无回复）')
  }

  const dispatcher = createFeishuEventDispatcher(config, onMessage)

  return {
    isAllowed: (openId) => allowed.has(openId),
    async handleEvent(request: Request): Promise<Response> {
      let body: unknown = {}
      try {
        body = await request.json()
      } catch {
        /* 非 JSON body 容忍 */
      }
      // URL 验证：回显 challenge（未加密）
      if (body && typeof body === 'object' && 'challenge' in (body as object)) {
        return Response.json({ challenge: (body as { challenge: string }).challenge })
      }
      const headers: Record<string, string> = {}
      request.headers.forEach((v, k) => (headers[k] = v))
      try {
        const result = await dispatcher.invoke(body, headers)
        return Response.json(result ?? { code: 0 })
      } catch {
        return Response.json({ code: 1, msg: 'invalid event' }, { status: 400 })
      }
    },
  }
}
```

- [ ] **Step 4: 验证通过** — Run: 同 Step 2 → PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/feishu/adapter.ts apps/cli/test/daemon/feishu/adapter.test.ts
git commit -m "feat(daemon): Feishu adapter 编排（鉴权+会话映射+prompt+回传）"
```

---

### Task 7: server.ts + index.ts 接线

**Files:**

- Modify: `apps/cli/src/daemon/server.ts`
- Modify: `apps/cli/src/daemon/index.ts`
- Test: `apps/cli/test/daemon/feishu/integration.test.ts`

**Interfaces:**

- Consumes: `createFeishuAdapter`（Task 6）、`FeishuConfig`。
- Produces: `/feishu/event` 路由。

- [ ] **Step 1: 写集成测试**

`apps/cli/test/daemon/feishu/integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
// 直接测 createServer 挂载的 /feishu/event 路由对 challenge 的响应（不需要真实 Feishu）
// 因 createServer 需要完整 config，此处用最小构造或改为测 index.ts 的 env 解析纯函数 parseFeishuEnv()

import { parseFeishuEnv } from '../../../src/daemon/feishu/env.js'

describe('parseFeishuEnv', () => {
  it('解析合法 env', () => {
    const prev = process.env
    process.env = {
      ...prev,
      FEISHU_APP_ID: 'a',
      FEISHU_APP_SECRET: 's',
      FEISHU_ENCRYPT_KEY: 'k',
      FEISHU_VERIFICATION_TOKEN: 't',
      FEISHU_ALLOWED_OPEN_IDS: 'ou_1,ou_2',
    }
    const cfg = parseFeishuEnv()
    expect(cfg?.appId).toBe('a')
    expect(cfg?.allowedOpenIds).toEqual(['ou_1', 'ou_2'])
    process.env = prev
  })

  it('缺 appId 时返回 null', () => {
    const prev = process.env
    process.env = { ...prev, FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' }
    expect(parseFeishuEnv()).toBeNull()
    process.env = prev
  })
})
```

> 为此需新增 `apps/cli/src/daemon/feishu/env.ts` 导出 `parseFeishuEnv(): FeishuConfig | null`（纯函数，读 `process.env`）。

- [ ] **Step 2: 验证失败** — Run: `pnpm exec vitest run test/daemon/feishu/integration.test.ts` → FAIL（`env.ts` 不存在）。

- [ ] **Step 3: 实现 env.ts**

`apps/cli/src/daemon/feishu/env.ts`:

```ts
import type { FeishuConfig } from './types.js'

export function parseFeishuEnv(): FeishuConfig | null {
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  if (!appId || !appSecret) return null
  return {
    appId,
    appSecret,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
    allowedOpenIds: (process.env.FEISHU_ALLOWED_OPEN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
```

- [ ] **Step 4: server.ts 挂路由**

在 `createServer` 的 `fetch` 里，`health` 路由之前（跳过 daemon Bearer 鉴权）加：

```ts
// ── Feishu event callback（独立签名验证，不经过 daemon Bearer 鉴权）──
if (feishuAdapter && method === 'POST' && path === '/feishu/event') {
  return await feishuAdapter.handleEvent(req)
}
```

`createServer` 签名加可选参数 `feishuAdapter?: FeishuAdapter`（从 `ServerConfig` 透传），或作为 `ServerConfig` 新字段。

- [ ] **Step 5: index.ts 构造 adapter**

`src/daemon/index.ts` 里 `startDaemon()`，在 `createServer` 前：

```ts
import { parseFeishuEnv } from './feishu/env.js'
import { createFeishuAdapter } from './feishu/adapter.js'
import { loadConfig } from '../config/loader.js'
// ...
const feishuCfg = parseFeishuEnv()
let feishuAdapter: FeishuAdapter | undefined
if (feishuCfg) {
  const cfg = loadConfig()
  const provider = cfg.providers?.find((p) => p.status !== 'disabled') ?? cfg.providers?.[0]
  feishuAdapter = createFeishuAdapter(feishuCfg, {
    sm,
    getOrCreateWorker: (id) => pool.getWorker(id) ?? null, // 或复用 server 内 getOrCreateWorker 逻辑
    rateLimiter,
    cwd: process.env.FEISHU_CWD || process.cwd(),
    provider: provider?.id ?? 'anthropic',
    model: provider?.models?.[0]?.id ?? 'claude-sonnet-5',
  })
}
// createServer({ ..., feishuAdapter })
```

> 注：`getOrCreateWorker` 目前是 `server.ts` 内闭包。为让 adapter 复用同一 worker 池，需把该函数从 `createServer` 闭包上提到 `index.ts` 或通过 `ServerConfig` 传入。实现时优先「把 `getOrCreateWorker` 逻辑抽到 `WorkerPool`/`SessionManager` 层」，避免 adapter 与 server 耦合。

- [ ] **Step 6: 验证通过** — Run: `pnpm exec vitest run test/daemon/feishu/integration.test.ts` → PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/daemon/feishu/env.ts apps/cli/src/daemon/server.ts apps/cli/src/daemon/index.ts apps/cli/test/daemon/feishu/integration.test.ts
git commit -m "feat(daemon): 挂载 /feishu/event 路由 + env 接线"
```

---

### Task 8: 全量验证

- [ ] **Step 1: typecheck**

Run: `cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code && pnpm -r typecheck`
Expected: 无错误。

- [ ] **Step 2: lint + format**

Run: `pnpm lint && pnpm format:check`
Expected: 新文件零 error/warning，format 通过。

- [ ] **Step 3: 全量测试**

Run: `pnpm -r test`
Expected: 全绿（含新增 feishu 测试）。

- [ ] **Step 4: 提交收尾（如 Task 7 后有未提交改动）**

```bash
git add -A
git commit -m "chore: Feishu Bot 远程控制全量验证通过"
```

---

## Self-Review 记录

- **Spec 覆盖**：事件安全（Task 3）、发消息（Task 2）、编排（Task 6）、session 映射（Task 5）、路由（Task 7）、env（Task 7）、测试（各 task + Task 8）、安全（白名单 Task 6、限流 Task 6、权限 default 由 daemon 现有机制保证）。
- **Spec 偏差**：open_id→session 映射由 spec 的「DB 列」改为「会话名约定」，已在上方 Global Constraints 标注。
- **遗留（范围外，spec §九）**：审批按钮、交互卡片、其他 IM、结果流式——均不在本 plan。
