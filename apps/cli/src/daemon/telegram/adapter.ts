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
