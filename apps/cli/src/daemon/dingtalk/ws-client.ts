import type { DingtalkApi } from './api.js'
import type { DingtalkMessage } from './types.js'
import { nextBackoff } from '../backoff.js'

/**
 * 钉钉 Stream 长连接生命周期：register（HTTP 拿 endpoint+ticket）→ 建连 →
 * 服务端 ping/pong → 消息回调（parse→ack→onMessage）→ 断开重连。ticket 一次性
 * 且 90s 过期，故每次重连前必须重新 register。返回 stop。
 */
export function startDingtalkWs(
  api: DingtalkApi,
  onMessage: (msg: DingtalkMessage) => Promise<void>,
): () => void {
  let stopped = false
  let ws: WebSocket | null = null
  let backoffMs = 1000
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function clearReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  function scheduleReconnect() {
    if (stopped) return
    reconnectTimer = setTimeout(() => void connect(), backoffMs)
    backoffMs = nextBackoff(backoffMs)
    ;(reconnectTimer as unknown as { unref?: () => void }).unref?.()
  }

  async function connect() {
    if (stopped) return
    let endpoint: string
    let ticket: string
    try {
      ;({ endpoint, ticket } = await api.register())
    } catch {
      scheduleReconnect()
      return
    }
    if (stopped) return
    ws = api.open(endpoint, ticket)
    ws.onopen = () => {
      backoffMs = 1000
    }
    ws.onmessage = (ev) => {
      let frame: unknown
      try {
        frame = JSON.parse(ev.data as string)
      } catch {
        return
      }
      if (api.isPing(frame)) {
        if (ws) api.pong(ws, frame)
        return
      }
      const msg = api.parseMessage(frame)
      if (msg) {
        if (ws) api.ack(ws, frame)
        void onMessage(msg).catch(() => {})
      }
    }
    ws.onclose = () => {
      ws = null
      scheduleReconnect()
    }
  }

  void connect()
  return () => {
    stopped = true
    clearReconnect()
    if (ws) {
      try {
        ws.close()
      } catch {
        /* 连接尚未建立时 close 可能抛错，忽略 */
      }
    }
  }
}
