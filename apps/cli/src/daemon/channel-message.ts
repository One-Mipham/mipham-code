import type { SessionManager } from './session-manager'
import type { SessionWorker } from './session-worker'
import type { RateLimiter } from './rate-limiter'

export interface ChannelMessageOptions {
  channel: string // 'feishu' | 'telegram' | 'wecom' | 'dingtalk'
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
  maxLen: number // 飞书 4000 / Telegram 4096 / 企微 2048 / 钉钉 2000
  logPrefix: string // '[feishu]' / '[telegram]' / '[wecom]'
}

/** 四频道共享的消息处理骨架：白名单→限流→会话→processPrompt→回发。 */
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
