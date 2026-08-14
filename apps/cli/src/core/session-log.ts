import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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

const HOME = process.env.HOME || '~'
const LOG_DIR = join(HOME, '.mipham', 'sessions')

export class SessionLog {
  private buf: SessionEvent[] = []
  private now: () => number

  constructor(private name: string, opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now())
  }

  append(event: SessionEvent): void {
    this.buf.push(event)
  }

  /** 不可变快照（浅拷贝，事件本身视为不可变）。 */
  events(): SessionEvent[] {
    return [...this.buf]
  }

  /** 追加写入 JSONL（每行一个事件，不重写整文件）。 */
  save(): void {
    mkdirSync(LOG_DIR, { recursive: true })
    for (const e of this.buf) {
      appendFileSync(join(LOG_DIR, `${this.name}.jsonl`), JSON.stringify(e) + '\n', 'utf-8')
    }
  }

  /** 从既有 JSONL 打开，逐行解析为事件。 */
  static open(name: string): SessionLog {
    const log = new SessionLog(name)
    const path = join(LOG_DIR, `${name}.jsonl`)
    if (!existsSync(path)) return log
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        log.buf.push(JSON.parse(trimmed) as SessionEvent)
      } catch {
        // 跳过损坏行
      }
    }
    return log
  }
}

const SUMMARY_PREFIX = '[Earlier conversation summary]:'

export function isCompactionSummary(m: Message): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX)
}

function messagesEqual(a: Message, b: Message): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 断言 messages 是 deriveMessages(log) 的子序列（压缩摘要豁免）。失败即抛错（fail-loud）。 */
export function assertModelVisible(log: SessionEvent[], messages: Message[]): void {
  const derived = deriveMessages(log)
  let di = 0
  for (const m of messages) {
    if (isCompactionSummary(m)) continue
    while (di < derived.length && !messagesEqual(derived[di]!, m)) di++
    if (di >= derived.length) {
      throw new Error(`Model-visible message not logged: ${JSON.stringify(m).slice(0, 200)}`)
    }
    di++
  }
}

/** replay：从日志派生完整消息历史（回归测试可断言其确定性）。 */
export function replayMessages(log: SessionLog): Message[] {
  return deriveMessages(log.events())
}

/** fork：截取日志前缀（到 uptoIndex，含）作为子会话继承的基。 */
export function forkEvents(events: SessionEvent[], uptoIndex: number): SessionEvent[] {
  return events.slice(0, uptoIndex)
}

/** resume：从日志恢复消息历史（与 replay 同源；独立命名便于语义区分）。 */
export function resumeMessages(log: SessionLog): Message[] {
  return deriveMessages(log.events())
}
