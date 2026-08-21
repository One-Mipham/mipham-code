import type { WecomConfig, WecomMessage } from './types.js'

export interface WecomApi {
  open(): WebSocket
  subscribe(ws: WebSocket): void
  ping(ws: WebSocket): void
  attach(ws: WebSocket | null): void
  respond(userId: string, text: string): void
  parseMessage(frame: unknown): WecomMessage | null
  isDisconnected(frame: unknown): boolean
}

const WS_ENDPOINT = 'wss://openws.work.weixin.qq.com'

/** 协议帧 codec；内部持有 activeWs（由 ws-client attach）。零依赖（globalThis.WebSocket）。 */
export function createWecomApi(config: WecomConfig): WecomApi {
  let activeWs: WebSocket | null = null
  return {
    open() {
      return new WebSocket(WS_ENDPOINT)
    },
    subscribe(ws) {
      ws.send(
        JSON.stringify({
          cmd: 'aibot_subscribe',
          body: { bot_id: config.botId, bot_secret: config.botSecret },
        }),
      )
    },
    ping(ws) {
      ws.send(JSON.stringify({ cmd: 'ping' }))
    },
    attach(ws) {
      activeWs = ws
    },
    respond(userId, text) {
      if (activeWs) {
        activeWs.send(
          JSON.stringify({ cmd: 'aibot_respond_msg', body: { userid: userId, content: text } }),
        )
      }
    },
    parseMessage(frame) {
      if (!frame || typeof frame !== 'object') return null
      const f = frame as {
        cmd?: string
        body?: { userid?: string; chatid?: string; msg_id?: string; content?: string }
      }
      if (f.cmd !== 'aibot_msg_callback' || !f.body) return null
      const { userid, chatid, msg_id, content } = f.body
      if (!userid || !content) return null
      return { userId: userid, chatId: chatid ?? '', msgId: msg_id ?? '', text: content }
    },
    isDisconnected(frame) {
      return (frame as { cmd?: string })?.cmd === 'disconnected_event'
    },
  }
}
