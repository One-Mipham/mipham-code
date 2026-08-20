import type { TelegramConfig } from './types.js'

export interface TelegramApi {
  getUpdates(
    offset: number,
    timeoutSeconds: number,
  ): Promise<Array<{ update_id: number; message?: unknown }>>
  sendText(chatId: string, text: string): Promise<void>
}

/** 裸 fetch 直连 Telegram Bot API，零依赖。 */
export function createTelegramApi(config: TelegramConfig): TelegramApi {
  const base = `https://api.telegram.org/bot${config.botToken}`
  return {
    async getUpdates(offset, timeoutSeconds) {
      const url =
        `${base}/getUpdates?offset=${offset}&timeout=${timeoutSeconds}` +
        `&limit=100&allowed_updates=%5B%22message%22%5D`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`getUpdates ${res.status}`)
      const data = (await res.json()) as {
        ok: boolean
        result?: Array<{ update_id: number; message?: unknown }>
        error_code?: number
        description?: string
      }
      if (!data.ok) throw new Error(`getUpdates failed: ${data.error_code ?? res.status}`)
      return data.result ?? []
    },
    async sendText(chatId, text) {
      const res = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      })
      if (!res.ok) throw new Error(`sendMessage ${res.status}`)
      const data = (await res.json()) as {
        ok: boolean
        error_code?: number
        description?: string
      }
      if (!data.ok) throw new Error(`sendMessage failed: ${data.error_code ?? res.status}`)
    },
  }
}
