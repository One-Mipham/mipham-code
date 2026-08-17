export interface FeishuConfig {
  appId: string
  appSecret: string
  encryptKey: string
  verificationToken: string
  allowedOpenIds: string[]
}

export interface FeishuTextMessage {
  chatId: string
  messageId: string
  openId: string
  text: string
}
