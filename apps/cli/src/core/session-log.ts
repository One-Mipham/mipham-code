import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Message, ToolUseContent, ToolResultContent, ToolResult } from '../shared/types'
import type { CheckerDecision } from './post-flight-checker'

export type SessionEvent =
  | {
      type: 'session/start'
      at: number
      sessionId: string
      provider?: string
      model?: string
      cwd?: string
    }
  | { type: 'user/message'; at: number; message: Message }
  | { type: 'assistant/message'; at: number; message: Message }
  | { type: 'tool/call'; at: number; id: string; name: string; input: Record<string, unknown> }
  | { type: 'assistant/chunk'; at: number; chunk: string }
  | { type: 'tool/result'; at: number; id: string; result: ToolResult }
  | { type: 'context/inject'; at: number; source: string; text: string }
  | { type: 'compaction/summary'; at: number; summary: string; replacedCount: number }
  | { type: 'compaction/rewrite'; at: number; messages: Message[] }
  | { type: 'checker/decision'; at: number; toolName: string; decision: CheckerDecision }

export function messageToEvents(msg: Message, at = 0): SessionEvent[] {
  if (msg.role === 'user') {
    if (Array.isArray(msg.content)) {
      const results = msg.content.filter((b) => b.type === 'tool_result') as ToolResultContent[]
      // 仅当内容是「单个 tool_result 块」才拆分为 tool/result，保证 deriveMessages 字节级还原
      if (results.length === 1 && results.length === msg.content.length) {
        const r = results[0]!
        return [
          {
            type: 'tool/result',
            at,
            id: r.tool_use_id,
            result: { success: true, content: r.content },
          },
        ]
      }
      return [{ type: 'user/message', at, message: msg }]
    }
    return [{ type: 'user/message', at, message: msg }]
  }
  if (msg.role === 'assistant') {
    if (Array.isArray(msg.content)) {
      const uses = msg.content.filter((b) => b.type === 'tool_use') as ToolUseContent[]
      // 仅当内容是「单个 tool_use 块」且 reasoning_content === '' 才拆分为 tool/call（引擎约定），
      // 否则整条嵌入 assistant/message，保证 reasoning_content 存在性与多块边界字节级还原
      if (uses.length === 1 && uses.length === msg.content.length && msg.reasoning_content === '') {
        const u = uses[0]!
        return [{ type: 'tool/call', at, id: u.id, name: u.name, input: u.input }]
      }
      return [{ type: 'assistant/message', at, message: msg }]
    }
    return [{ type: 'assistant/message', at, message: msg }]
  }
  return [] // system 消息不产事件（引擎 system prompt 走独立通道）
}

export function deriveMessages(events: SessionEvent[]): Message[] {
  let out: Message[] = []
  for (const e of events) {
    if (e.type === 'user/message' || e.type === 'assistant/message') {
      out.push(e.message)
    } else if (e.type === 'assistant/chunk') {
      // 无消息：原始块由 assistant/message 汇总，chunk 仅供 replayChunks 流级回放
    } else if (e.type === 'tool/call') {
      out.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: e.id, name: e.name, input: e.input }],
        reasoning_content: '',
      })
    } else if (e.type === 'tool/result') {
      // 兼容旧 JSONL（存 content:string）；新格式存 result:ToolResult（含 success/error）
      const eo = e as unknown as { id: string; result?: ToolResult; content?: string }
      const result: ToolResult = eo.result ?? { success: true, content: eo.content ?? '' }
      const content = result.success ? result.content : result.error || result.content
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: e.id, content }],
      })
    } else if (e.type === 'context/inject') {
      out.push({ role: 'user', content: e.text })
    } else if (e.type === 'compaction/summary') {
      // replacedCount = 被摘要替换的前缀消息数；旧 JSONL 无此字段则退回「追加末尾」
      const n = (e as { replacedCount?: number }).replacedCount ?? 0
      if (n > 0) {
        out.splice(0, n)
        out.unshift({ role: 'user', content: `[Earlier conversation summary]: ${e.summary}` })
      } else {
        out.push({ role: 'user', content: `[Earlier conversation summary]: ${e.summary}` })
      }
    } else if (e.type === 'compaction/rewrite') {
      // 快照替换：整个投影重建（微压缩/截断等结构性编辑的字节级复现）
      out = structuredClone(e.messages)
    }
    // 'session/start' / 'checker/decision' → 无消息（决策仅记录证据，不进投影，保字节级可逆）
  }
  return out
}

const HOME = process.env.HOME || '~'
const LOG_DIR = join(HOME, '.mipham', 'sessions')

/** 将会话名消毒为安全文件名（与 SessionStore 共用；防路径穿越）。 */
export function sanitizeSessionName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (safe.length > 100) {
    const hash = createHash('sha256').update(safe).digest('hex').slice(0, 16)
    return `${safe.slice(0, 80)}-${hash}`
  }
  return safe
}

export class SessionLog {
  private buf: SessionEvent[] = []
  private flushed = 0

  constructor(private name: string) {}

  append(event: SessionEvent): void {
    this.buf.push(event)
  }

  /** 不可变快照（浅拷贝，事件本身视为不可变）。 */
  events(): SessionEvent[] {
    return [...this.buf]
  }

  /** 追加写入 JSONL（只写上次 save 之后新增的事件，幂等）。 */
  save(): void {
    // Session logs contain full conversation + tool results (possibly credentials):
    // restrict to owner-only (dir 0700, file 0600).
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
    for (const e of this.buf.slice(this.flushed)) {
      appendFileSync(
        join(LOG_DIR, `${sanitizeSessionName(this.name)}.jsonl`),
        JSON.stringify(e) + '\n',
        { encoding: 'utf-8', mode: 0o600 },
      )
    }
    this.flushed = this.buf.length
  }

  /** 从既有 JSONL 打开，逐行解析为事件（已落盘事件标记为已 flush）。 */
  static open(name: string): SessionLog {
    const log = new SessionLog(name)
    const path = join(LOG_DIR, `${sanitizeSessionName(name)}.jsonl`)
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
    log.flushed = log.buf.length
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

/** 断言 messages 是 deriveMessages(log) 的子序列（压缩摘要豁免）。失败即抛错（fail-loud）。
 *  纯工具 + 测试断言；运行时接线见 ContextManager（debug 门控，默认关闭）。 */
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

// ── 运行时断言门控 ──
let debugAssertModelVisible = false

/** 开启/关闭运行时「model-visible means logged」断言（默认关闭；hot-path 成本）。 */
export function setAssertModelVisibleDebug(enabled: boolean): void {
  debugAssertModelVisible = enabled
}

/** 运行时断言当前是否开启。 */
export function isAssertModelVisibleDebug(): boolean {
  return debugAssertModelVisible
}

/** replay：从日志派生完整消息历史（回归测试可断言其确定性）。 */
export function replayMessages(log: SessionLog): Message[] {
  return deriveMessages(log.events())
}

/** fork：截取日志前 uptoIndex 个事件（half-open，不含 uptoIndex）作为子会话继承的基。 */
export function forkEvents(events: SessionEvent[], uptoIndex: number): SessionEvent[] {
  return events.slice(0, uptoIndex)
}

/** resume：从日志恢复消息历史（与 replay 同源；独立命名便于语义区分）。 */
export function resumeMessages(log: SessionLog): Message[] {
  return deriveMessages(log.events())
}

/** replay：从日志抽取原始 assistant 流块（保 replay 保真）。 */
export function replayChunks(log: SessionLog): string[] {
  return log
    .events()
    .filter(
      (e): e is Extract<SessionEvent, { type: 'assistant/chunk' }> => e.type === 'assistant/chunk',
    )
    .map((e) => e.chunk)
}
