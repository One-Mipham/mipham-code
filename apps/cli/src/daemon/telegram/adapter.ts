import type { TelegramApi } from './api.js'
import type { TelegramConfig, TelegramMessage } from './types.js'
import type { SessionManager } from '../session-manager'
import type { SessionWorker } from '../session-worker'
import type { RateLimiter } from '../rate-limiter'
import { handleChannelMessage } from '../channel-message.js'
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
