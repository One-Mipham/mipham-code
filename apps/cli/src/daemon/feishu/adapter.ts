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
      const result = await dispatcher.invoke(body, headers)
      if (!result.ok) {
        return Response.json({ code: 1, msg: result.reason }, { status: 400 })
      }
      return Response.json({ code: 0 })
    },
  }
}
