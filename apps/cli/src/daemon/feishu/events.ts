import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig, FeishuTextMessage } from './types.js'

export type OnFeishuMessage = (msg: FeishuTextMessage) => Promise<void>

export interface FeishuEventDispatcher {
  invoke(body: unknown, headers: Record<string, string>): Promise<unknown>
}

export function createFeishuEventDispatcher(
  config: FeishuConfig,
  onMessage: OnFeishuMessage,
): FeishuEventDispatcher {
  const dispatcher = new lark.EventDispatcher({
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
  }).register({
    'im.message.receive_v1': async (data: any) => {
      const message = data?.message
      if (message?.message_type !== 'text') return
      let text = ''
      try {
        text = JSON.parse(message.content).text ?? ''
      } catch {
        return
      }
      const openId = data?.sender?.sender_id?.open_id
      if (!openId || !text) return
      await onMessage({ chatId: message.chat_id, messageId: message.message_id, openId, text })
    },
  })

  return {
    async invoke(body, headers) {
      const assigned = Object.assign(Object.create({ headers }), body)
      return await dispatcher.invoke(assigned)
    },
  }
}
