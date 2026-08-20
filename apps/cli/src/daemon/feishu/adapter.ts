import { createFeishuApi } from './api.js'
import { createFeishuEventDispatcher } from './events.js'
import type { FeishuConfig, FeishuTextMessage } from './types.js'
import type { SessionManager } from '../session-manager'
import type { SessionWorker } from '../session-worker'
import type { RateLimiter } from '../rate-limiter'

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
    try {
      if (!allowed.has(msg.openId)) return
      if (!deps.rateLimiter.check(`feishu:${msg.openId}`).allowed) return

      const session = deps.sm.getOrCreateByExternalUser(
        'feishu',
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
    } catch (err) {
      console.error('[feishu] message handling failed:', err)
      try {
        await api.sendText(msg.openId, '（处理失败，请稍后重试）')
      } catch {
        /* 忽略回送失败，确保不 rethrow → Feishu 不重试 */
      }
    }
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
