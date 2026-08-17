import type { FeishuConfig } from './types.js'

export function parseFeishuEnv(): FeishuConfig | null {
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY || ''
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN || ''
  // Fail-closed：encryptKey 必填。lark SDK 对 im.message.receive_v1 事件流的签名验证
  // 只依赖 encryptKey（checkIsEventValidated 在空 key 时静默返回 true）；
  // verificationToken 仅用于 URL challenge 握手，不保护事件流，故保持可选。
  if (!appId || !appSecret || !encryptKey) return null
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
