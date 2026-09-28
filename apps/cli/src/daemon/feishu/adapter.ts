import { createFeishuApi } from './api.js'
import { createFeishuEventDispatcher } from './events.js'
import type { FeishuConfig, FeishuTextMessage } from './types.js'
import type { SessionManager } from '../session-manager'
import type { SessionWorker } from '../session-worker'
import type { RateLimiter } from '../rate-limiter'
import { handleChannelMessage } from '../channel-message.js'

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

/**
 * 单次请求体上限。Feishu 事件体在 KB 量级，256 KiB 已是两个数量级的余量。
 *
 * 为什么必须在**解析之前**封顶：`handleEvent` 从前直接 `await request.json()`，
 * 而签名校验发生在**解析之后** —— 于是拒绝的代价由被拒方转嫁给了守护进程：
 * 未鉴权的调用方可以先让它吞下整个体（Bun 默认 `maxRequestBodySize` = 128 MB，
 * 实测 127 MB 通过 / 140 MB 才 413），再拿到那句 400。限流（`server.ts`）管的是
 * **频次**，这里管的是**单次成本**，两道各管一件事。
 */
const MAX_BODY_BYTES = 256 * 1024

type BoundedBody = { ok: true; text: string } | { ok: false }

/**
 * 读取请求体，超过 `MAX_BODY_BYTES` 即中止并返回 `ok: false`。
 *
 * 按**流式累计**封顶而非只看 `Content-Length`：声明可以缺席（chunked）也可以撒谎，
 * 只有累计读数才是真判据；`Content-Length` 只用作廉价的第一道，免得把一个自报
 * 超限的体读进来再发现。
 */
async function readBoundedBody(request: Request): Promise<BoundedBody> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false }

  const stream = request.body
  if (!stream) return { ok: true, text: '' }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {
        /* 中止流的失败不影响本次拒绝 */
      })
      return { ok: false }
    }
    chunks.push(value)
  }

  const buf = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, text: new TextDecoder().decode(buf) }
}

export function createFeishuAdapter(config: FeishuConfig, deps: FeishuAdapterDeps): FeishuAdapter {
  const api = createFeishuApi(config)
  const allowed = new Set(config.allowedOpenIds)

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

  const dispatcher = createFeishuEventDispatcher(config, onMessage)

  return {
    isAllowed: (openId) => allowed.has(openId),
    async handleEvent(request: Request): Promise<Response> {
      const bounded = await readBoundedBody(request)
      if (!bounded.ok) {
        return Response.json({ code: 1, msg: 'payload_too_large' }, { status: 413 })
      }
      let body: unknown = {}
      try {
        body = JSON.parse(bounded.text)
      } catch {
        /* 非 JSON body 容忍 */
      }
      // URL 验证：回显 challenge（未加密）
      if (body && typeof body === 'object' && 'challenge' in (body as object)) {
        return Response.json({ challenge: (body as { challenge: string }).challenge })
      }
      const headers: Record<string, string> = {}
      request.headers.forEach((v, k) => (headers[k] = v))
      const result = await dispatcher.invoke(body, headers)
      if (!result.ok) {
        return Response.json({ code: 1, msg: result.reason }, { status: 400 })
      }
      return Response.json({ code: 0 })
    },
  }
}
