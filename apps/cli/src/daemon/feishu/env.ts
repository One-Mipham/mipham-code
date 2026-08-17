import type { FeishuConfig } from './types.js'

export function parseFeishuEnv(): FeishuConfig | null {
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY || ''
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN || ''
  // Fail-closed：至少配置一种安全密钥（encryptKey 或 verificationToken）。
  // 否则 lark SDK 的签名验证会静默失效（checkIsEventValidated 在空 key 时返回 true），
  // 非 loopback 绑定下会接受伪造事件 → 未授权远程 prompt 执行。
  if (!appId || !appSecret || (!encryptKey && !verificationToken)) return null
  return {
    appId,
    appSecret,
    encryptKey,
    verificationToken,
    allowedOpenIds: (process.env.FEISHU_ALLOWED_OPEN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
