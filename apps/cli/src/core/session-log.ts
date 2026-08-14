import type { Message, ToolUseContent, ToolResultContent } from '../shared/types'

export type SessionEvent =
  | { type: 'session/start'; at: number; sessionId: string }
  | { type: 'user/message'; at: number; message: Message }
  | { type: 'assistant/message'; at: number; message: Message }
  | { type: 'tool/call'; at: number; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool/result'; at: number; id: string; content: string }
  | { type: 'context/inject'; at: number; source: string; text: string }
  | { type: 'compaction/summary'; at: number; summary: string }

export function messageToEvents(msg: Message, at = 0): SessionEvent[] {
  if (msg.role === 'user') {
    if (Array.isArray(msg.content)) {
      const results = msg.content.filter((b) => b.type === 'tool_result') as ToolResultContent[]
      if (results.length > 0 && results.length === msg.content.length) {
        return results.map((r) => ({ type: 'tool/result', at, id: r.tool_use_id, content: r.content }))
      }
      return [{ type: 'user/message', at, message: msg }]
    }
    return [{ type: 'user/message', at, message: msg }]
  }
  if (msg.role === 'assistant') {
    if (Array.isArray(msg.content)) {
      const uses = msg.content.filter((b) => b.type === 'tool_use') as ToolUseContent[]
      if (uses.length > 0 && uses.length === msg.content.length) {
        return uses.map((u) => ({ type: 'tool/call', at, id: u.id, name: u.name, input: u.input }))
      }
      return [{ type: 'assistant/message', at, message: msg }]
    }
    return [{ type: 'assistant/message', at, message: msg }]
  }
  return [] // system 消息不产事件（引擎 system prompt 走独立通道）
}

export function deriveMessages(events: SessionEvent[]): Message[] {
  const out: Message[] = []
  for (const e of events) {
    if (e.type === 'user/message' || e.type === 'assistant/message') {
      out.push(e.message)
    } else if (e.type === 'tool/call') {
      out.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: e.id, name: e.name, input: e.input }],
        reasoning_content: '',
      })
    } else if (e.type === 'tool/result') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: e.id, content: e.content }],
      })
    } else if (e.type === 'context/inject') {
      out.push({ role: 'user', content: e.text })
    } else if (e.type === 'compaction/summary') {
      out.push({ role: 'user', content: `[Earlier conversation summary]: ${e.summary}` })
    }
    // 'session/start' → 无消息
  }
  return out
}
