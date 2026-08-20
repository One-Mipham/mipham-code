export interface TelegramConfig {
  botToken: string
  allowedChatIds: string[]
}

export interface TelegramMessage {
  chatId: string
  messageId: number
  text: string
}
