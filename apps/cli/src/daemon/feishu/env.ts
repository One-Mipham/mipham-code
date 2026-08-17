import type { FeishuConfig } from './types.js'

export function parseFeishuEnv(): FeishuConfig | null {
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  if (!appId || !appSecret) return null
  return {
    appId,
    appSecret,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
    allowedOpenIds: (process.env.FEISHU_ALLOWED_OPEN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
