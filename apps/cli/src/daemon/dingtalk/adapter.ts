import type { DingtalkApi } from './api.js'
import type { DingtalkConfig, DingtalkMessage } from './types.js'
import type { SessionManager } from '../session-manager'
import type { SessionWorker } from '../session-worker'
import type { RateLimiter } from '../rate-limiter'
import { startDingtalkWs } from './ws-client.js'
import { handleChannelMessage } from '../channel-message.js'

export interface DingtalkAdapterDeps {
  sm: SessionManager
  getOrCreateWorker: (sessionId: string) => SessionWorker | null
  rateLimiter: RateLimiter
  cwd: string
  provider: string
  model: string
}

export interface DingtalkAdapter {
  start(): () => void
  handleMessage(msg: DingtalkMessage): Promise<void>
  isAllowed(staffId: string): boolean
}

export function createDingtalkAdapter(
  config: DingtalkConfig,
  api: DingtalkApi,
  deps: DingtalkAdapterDeps,
): DingtalkAdapter {
  const allowed = new Set(config.allowedStaffIds)
  let stopWs: (() => void) | null = null

  async function handleMessage(msg: DingtalkMessage): Promise<void> {
    await handleChannelMessage({
      channel: 'dingtalk',
      externalId: msg.staffId,
      text: msg.text,
      allowed,
      rateLimiter: deps.rateLimiter,
      sm: deps.sm,
      getOrCreateWorker: deps.getOrCreateWorker,
      cwd: deps.cwd,
      provider: deps.provider,
      model: deps.model,
      // 钉钉回发走每条消息自带的 sessionWebhook（非持久 userId 路由）
      sendText: async (_staffId, text) => {
        await api.reply(msg.sessionWebhook, text)
      },
      maxLen: 2000,
      logPrefix: '[dingtalk]',
    })
  }

  return {
    handleMessage,
    isAllowed: (staffId) => allowed.has(staffId),
    start() {
      if (stopWs) return stopWs
      stopWs = startDingtalkWs(api, handleMessage)
      return stopWs
    },
  }
}
