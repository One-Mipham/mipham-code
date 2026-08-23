export interface DingtalkConfig {
  clientId: string
  clientSecret: string
  allowedStaffIds: string[] // 白名单（钉钉 senderStaffId / senderId）
}

export interface DingtalkMessage {
  staffId: string // 发消息用户（senderStaffId，回退 senderId）
  conversationId: string // 会话 id
  msgId: string // 消息 id（业务侧）
  text: string // 文本内容
  sessionWebhook: string // 回发路由（机器人 sessionWebhook URL）
}
