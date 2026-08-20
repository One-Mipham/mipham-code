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
