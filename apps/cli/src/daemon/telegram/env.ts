import type { TelegramConfig } from './types.js'

/** fail-closed：缺 botToken → null（daemon 不启用 Telegram）。 */
export function parseTelegramEnv(): TelegramConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return null
  return {
    botToken,
    allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
