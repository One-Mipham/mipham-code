import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Message, ToolUseContent, ToolResultContent, ToolResult } from '../shared/types'
import type { CheckerDecision } from './post-flight-checker'
import { appendRegularFileSync, readRegularFileSync } from '../shared/regular-file'
import { miphamHome } from './paths.ts'

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
            // 读真值：旧消息无 is_error ⇒ 视为成功（向后兼容，无需迁移）
            result: { success: !(r.is_error === true), content: r.content },
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
      // `?? ''`：成功但没记下 content 的事件（`JSON.stringify` 会把 `undefined` 的键整个
      // 抹掉，所以它在盘上长这样：`{"success":true}`）投影出来必须是**字符串**。
      // 投影负责形状、provider 负责出网合法（`tool_result.content` 是 `string`）；
      // 这里留 `undefined` 会让 `JSON.stringify` 同样抹掉该键，把问题送到线上。
      const content = (result.success ? result.content : result.error || result.content) ?? ''
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: e.id,
            content,
            // 展平式的对称边：成功不写该键（与 messageToEvents 侧对称，保字节级互逆）
            ...(result.success ? {} : { is_error: true }),
          },
        ],
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

const LOG_DIR = miphamHome('sessions')

/** 一次性告警：日志路径不是普通文件（写不进去），每个进程只说一句。 */
let warnedNotAppendable = false

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
    const path = join(LOG_DIR, `${sanitizeSessionName(this.name)}.jsonl`)
    let wrote = 0
    for (const e of this.buf.slice(this.flushed)) {
      // FIFO/socket 路径上「写不进去」而不是**干等**（`appendFileSync` 会打开目标写）。
      // 写失败时**不推进** flushed：这些事件还算未落盘，路径恢复后下一次 save 会补上。
      if (!appendRegularFileSync(path, JSON.stringify(e) + '\n', { mode: 0o600 })) {
        if (!warnedNotAppendable) {
          warnedNotAppendable = true
          process.stderr.write(
            `⚠ Mipham Code: ${path} is not a regular file — session log events were not written.\n`,
          )
        }
        break
      }
      wrote++
    }
    this.flushed += wrote
  }

  /** 从既有 JSONL 打开，逐行解析为事件（已落盘事件标记为已 flush）。 */
  static open(name: string): SessionLog {
    const log = new SessionLog(name)
    const path = join(LOG_DIR, `${sanitizeSessionName(name)}.jsonl`)
    // 类型闸在读取之前：`SessionStore.load` 在快照读不出来时**回落到这里**，所以路径上
    // 是个 FIFO 时不能在这里换个函数继续等 —— 读不动就当空日志（见 shared/regular-file.ts）。
    const raw = readRegularFileSync(path)
    if (raw === null) return log
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (!isValidEvent(parsed)) continue
        log.buf.push(parsed)
      } catch {
        // 跳过损坏行
      }
    }
    log.flushed = log.buf.length
    return log
  }
}

/**
 * 消息形状闸 —— 投影与**出网**两侧都会解引用的字段的最低门槛，不是 schema 校验。
 *
 * 从前这里只查「`message` 是个对象」，于是 `{"type":"user/message","message":{}}`
 * 一路活到线上：投影照原样收下它，provider 侧读到 `content` 为 `undefined` 走
 * 「非字符串即 `ContentBlock[]`」那条分支，`.filter` 当场 TypeError（实测）。
 * `content` 数组里的块同理 —— provider 会 `b.type` 逐个读。
 */
export function isValidMessage(m: unknown): boolean {
  if (!m || typeof m !== 'object') return false
  const msg = m as Record<string, unknown>
  if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') return false
  const content = msg.content
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.every((b) => !!b && typeof b === 'object')
}

/**
 * 事件结构校验 —— 磁盘→内存的**唯一**入口（`open()`）用它挡掉坏行。
 *
 * 只校验 `deriveMessages` 会解引用的字段：这不是 schema 校验，是「投影不许崩」的
 * 最低门槛。**合法 JSON 不等于合法事件** —— `null`、`{"type":"user/message"}`（无
 * message）、`{"type":"compaction/rewrite"}`（无 messages）都过得了 `JSON.parse`，
 * 却让投影抛 TypeError（rewrite 那条更狠：`out` 直接变 `undefined`，下一条就炸），
 * 而 `/resume` 那条链上没有 try 兜它。坏行来自手写/拼接/半截重排，不是本进程写的。
 *
 * 带 message 的事件还要过 `isValidMessage`：投影只把它 `push` 进数组、自己不碰字段，
 * 所以「投影不许崩」在这里**不够** —— 崩点在下游（provider 分支、UI 的 `msg.role`）。
 *
 * 不校验 `session/start`、`assistant/chunk`、`checker/decision`：投影对它们无分支；
 * 未知类型一律放行（前向兼容 —— 认不出来不等于要销毁它）。
 */
function isValidEvent(e: unknown): e is SessionEvent {
  if (!e || typeof e !== 'object') return false
  const ev = e as Record<string, unknown>
  if (typeof ev.type !== 'string') return false
  switch (ev.type) {
    case 'user/message':
    case 'assistant/message':
      return isValidMessage(ev.message)
    case 'tool/call':
      return (
        typeof ev.id === 'string' &&
        typeof ev.name === 'string' &&
        !!ev.input &&
        typeof ev.input === 'object'
      )
    case 'tool/result':
      // 只要求 id：`result`（新格式）与 `content`（旧 JSONL）都可缺省，派生侧已兜底
      return typeof ev.id === 'string'
    case 'context/inject':
      return typeof ev.text === 'string'
    case 'compaction/summary':
      return typeof ev.summary === 'string'
    case 'compaction/rewrite':
      // 快照替换：整份投影由它重建 ⇒ 元素形状与 message 事件同罪
      return Array.isArray(ev.messages) && ev.messages.every(isValidMessage)
    default:
      return true
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
