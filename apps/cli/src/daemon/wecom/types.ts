export interface WecomConfig {
  botId: string
  botSecret: string
  allowedUserIds: string[] // 白名单（企微内部 userid）
}

export interface WecomMessage {
  userId: string // 发消息用户（userid）
  chatId: string // 会话 id（chatid）
  msgId: string // 消息 id（req_id 关联回包）
  text: string // 文本内容
}
