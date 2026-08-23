import type { DingtalkConfig } from './types.js'

/** fail-closed：缺 clientId 或 clientSecret → null（daemon 不启用钉钉）。 */
export function parseDingtalkEnv(): DingtalkConfig | null {
  const clientId = process.env.DINGTALK_CLIENT_ID
  const clientSecret = process.env.DINGTALK_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return {
    clientId,
    clientSecret,
    allowedStaffIds: (process.env.DINGTALK_ALLOWED_STAFF_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
