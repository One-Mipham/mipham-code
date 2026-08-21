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
