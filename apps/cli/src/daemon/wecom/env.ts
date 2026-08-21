import type { WecomConfig } from './types.js'

/** fail-closed：缺 botId 或 botSecret → null（daemon 不启用企微）。 */
export function parseWecomEnv(): WecomConfig | null {
  const botId = process.env.WECOM_BOT_ID
  const botSecret = process.env.WECOM_BOT_SECRET
  if (!botId || !botSecret) return null
  return {
    botId,
    botSecret,
    allowedUserIds: (process.env.WECOM_ALLOWED_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
