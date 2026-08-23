import type { WecomApi } from './api.js'
import type { WecomMessage } from './types.js'
import { nextBackoff } from '../backoff.js'

/** WebSocket 长连接生命周期：建连→subscribe→心跳→消息回调→断开重连。返回 stop。 */
export function startWecomWs(
  api: WecomApi,
  onMessage: (msg: WecomMessage) => Promise<void>,
  opts?: { heartbeatMs?: number },
): () => void {
  const heartbeatMs = opts?.heartbeatMs ?? 30_000
  let stopped = false
  let disconnected = false // disconnected_event 触发时置 true，主动 close 后不重连
  let ws: WebSocket
  let backoffMs = 1000
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function clearTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    heartbeatTimer = null
    reconnectTimer = null
  }

  function connect() {
    if (stopped) return
    ws = api.open()
    ws.onopen = () => {
      backoffMs = 1000
      api.attach(ws)
      api.subscribe(ws)
      heartbeatTimer = setInterval(() => api.ping(ws), heartbeatMs)
      ;(heartbeatTimer as unknown as { unref?: () => void }).unref?.()
    }
    ws.onmessage = (ev) => {
      let frame: unknown
      try {
        frame = JSON.parse(ev.data as string)
      } catch {
        return
      }
      if (api.isDisconnected(frame)) {
        disconnected = true
        ws.close()
        return
      }
      const msg = api.parseMessage(frame)
      if (msg) void onMessage(msg).catch(() => {})
    }
    ws.onclose = () => {
      api.attach(null)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = null
      if (stopped || disconnected) return
      reconnectTimer = setTimeout(connect, backoffMs)
      backoffMs = nextBackoff(backoffMs)
      ;(reconnectTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  connect()
  return () => {
    stopped = true
    disconnected = true
    clearTimers()
    try {
      ws.close()
    } catch {
      /* 连接尚未建立时 close 可能抛错，忽略 */
    }
  }
}
