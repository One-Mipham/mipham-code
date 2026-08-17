import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig, FeishuTextMessage } from './types.js'

export type OnFeishuMessage = (msg: FeishuTextMessage) => Promise<void>

export type FeishuInvokeResult =
  { ok: true } | { ok: false; reason: 'invalid_signature' | 'no_handler' | 'parse_failed' }

export interface FeishuEventDispatcher {
  invoke(body: unknown, headers: Record<string, string>): Promise<FeishuInvokeResult>
}

export function createFeishuEventDispatcher(
  config: FeishuConfig,
  onMessage: OnFeishuMessage,
): FeishuEventDispatcher {
  const dispatcher = new lark.EventDispatcher({
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
  }).register({
    'im.message.receive_v1': async (data: any): Promise<true> => {
      const message = data?.message
      if (message?.message_type !== 'text') return true
      let text = ''
      try {
        text = JSON.parse(message.content).text ?? ''
      } catch {
        return true
      }
      const openId = data?.sender?.sender_id?.open_id
      if (!openId || !text) return true
      await onMessage({ chatId: message.chat_id, messageId: message.message_id, openId, text })
      return true
    },
  })

  return {
    async invoke(body, headers): Promise<FeishuInvokeResult> {
      const assigned = Object.assign(Object.create({ headers }), body)
      let raw: unknown
      try {
        raw = await dispatcher.invoke(assigned)
      } catch {
        return { ok: false, reason: 'parse_failed' }
      }
      if (raw === undefined) return { ok: false, reason: 'invalid_signature' }
      if (typeof raw === 'string' && raw.startsWith('no ')) {
        return { ok: false, reason: 'no_handler' }
      }
      return { ok: true }
    },
  }
}
