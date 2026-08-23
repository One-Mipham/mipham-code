import type { DingtalkConfig, DingtalkMessage } from './types.js'

const GATEWAY_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open'

export interface DingtalkApi {
  register(): Promise<{ endpoint: string; ticket: string }>
  open(endpoint: string, ticket: string): WebSocket
  reply(sessionWebhook: string, text: string): Promise<void>
  parseMessage(frame: unknown): DingtalkMessage | null
  isPing(frame: unknown): boolean
  ack(ws: WebSocket, frame: unknown): void
  pong(ws: WebSocket, frame: unknown): void
}

/**
 * 钉钉 Stream Mode 协议 codec。零依赖：HTTP 用裸 fetch（register + 回发），
 * WebSocket 用 globalThis.WebSocket（Node 22+ / Bun 原生）。ticket 一次性且
 * 90s 过期，由 ws-client 每次重连前重新 register。
 */
export function createDingtalkApi(
  config: DingtalkConfig,
  fetchImpl: typeof fetch = fetch,
): DingtalkApi {
  return {
    async register() {
      const res = await fetchImpl(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }],
          ua: 'mipham-code',
        }),
      })
      if (!res.ok) throw new Error(`dingtalk gateway register ${res.status}`)
      const data = (await res.json()) as { endpoint?: string; ticket?: string }
      if (!data.endpoint || !data.ticket) {
        throw new Error('dingtalk gateway: missing endpoint/ticket')
      }
      return { endpoint: data.endpoint, ticket: data.ticket }
    },

    open(endpoint, ticket) {
      return new WebSocket(`${endpoint}?ticket=${encodeURIComponent(ticket)}`)
    },

    async reply(sessionWebhook, text) {
      if (!sessionWebhook) return
      const res = await fetchImpl(sessionWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      })
      if (!res.ok) throw new Error(`dingtalk reply ${res.status}`)
      const data = (await res.json()) as { errcode?: number; errmsg?: string }
      if (data.errcode != null && data.errcode !== 0) {
        throw new Error(`dingtalk reply errcode=${data.errcode}: ${data.errmsg ?? 'unknown'}`)
      }
    },

    parseMessage(frame) {
      if (!frame || typeof frame !== 'object') return null
      const f = frame as { type?: string; data?: unknown }
      if (f.type !== 'CALLBACK' || typeof f.data !== 'string') return null
      let payload: {
        msgtype?: string
        text?: { content?: string }
        senderStaffId?: string
        senderId?: string
        conversationId?: string
        msgId?: string
        sessionWebhook?: string
      }
      try {
        payload = JSON.parse(f.data)
      } catch {
        return null
      }
      if (payload?.msgtype !== 'text') return null
      const text = payload?.text?.content?.trim()
      if (!text) return null
      const staffId = payload?.senderStaffId ?? payload?.senderId
      if (!staffId) return null
      return {
        staffId,
        conversationId: payload?.conversationId ?? '',
        msgId: payload?.msgId ?? '',
        text,
        sessionWebhook: payload?.sessionWebhook ?? '',
      }
    },

    isPing(frame) {
      const f = frame as { type?: string; headers?: { topic?: string } }
      return f?.type === 'SYSTEM' && f?.headers?.topic === 'ping'
    },

    ack(ws, frame) {
      const f = frame as { headers?: { messageId?: string } }
      ws.send(
        JSON.stringify({
          code: 200,
          headers: { contentType: 'application/json', messageId: f?.headers?.messageId ?? '' },
          message: 'OK',
          data: '{"response": null}',
        }),
      )
    },

    pong(ws, frame) {
      const f = frame as { headers?: { messageId?: string }; data?: unknown }
      ws.send(
        JSON.stringify({
          code: 200,
          headers: { contentType: 'application/json', messageId: f?.headers?.messageId ?? '' },
          message: 'OK',
          data: f?.data,
        }),
      )
    },
  }
}
