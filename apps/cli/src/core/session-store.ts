import { mkdirSync, readdirSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Message } from '../shared/types'
import {
  sanitizeSessionName,
  SessionLog,
  deriveMessages,
  messageToEvents,
  isValidMessage,
} from './session-log'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { readRegularFileSync } from '../shared/regular-file'
import { miphamHome } from './paths.ts'

export interface SessionMetadata {
  name: string
  createdAt: string
  updatedAt: string
  provider: string
  model: string
  messageCount: number
  cwd?: string
}

export interface StoredSession {
  metadata: SessionMetadata
  messages: Message[]
}

const SESSIONS_DIR = miphamHome('sessions')
const INDEX_FILE = join(SESSIONS_DIR, '.index.json')
const SUMMARIES_DIR = join(SESSIONS_DIR, '.summaries')

export interface SessionIndexEntry {
  name: string
  createdAt: string
  updatedAt: string
  provider: string
  model: string
  messageCount: number
  tokenCount: number
  cwd?: string
  summary?: string
  tags?: string[]
}

function ensureDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 })
}

function filePath(name: string): string {
  return join(SESSIONS_DIR, `${sanitizeSessionName(name)}.jsonl`)
}

/**
 * 旧格式快照（单 JSON 对象 `{metadata, messages}`）的形状闸。
 *
 * `'metadata' in parsed` 拦不住 `{"metadata": null, …}` —— `in` 看的是**键在不在**，
 * 而 `/resume <name>` 紧接着就读 `session.metadata.name`，那条链上没有 try（实测
 * `TypeError`）。`messages` 的元素同理：`[null]` 会一路送到 UI 的
 * `forwardedMessages.map((msg) => msg.role)`（`app.tsx:1041`）与 provider 的内容分支。
 *
 * 形状不对**整份返回 null**，而不是把坏元素过滤掉：调用方随即回落到事件日志那条路，
 * 读不出来会如实报 load failed；过滤则会凭空造出一段残缺历史 —— 静默改写用户数据。
 */
function asStoredSnapshot(parsed: unknown): StoredSession | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const { metadata, messages } = parsed as { metadata?: unknown; messages?: unknown }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  if (!Array.isArray(messages) || !messages.every(isValidMessage)) return null
  return { metadata: metadata as SessionMetadata, messages: messages as Message[] }
}

export class SessionStore {
  /**
   * Save a session as JSONL (one JSON object per line).
   */
  static save(
    name: string,
    messages: Message[],
    metadata?: { provider?: string; model?: string; cwd?: string },
  ): void {
    ensureDir()
    const path = filePath(name)

    const session: StoredSession = {
      metadata: {
        name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        provider: metadata?.provider || 'unknown',
        model: metadata?.model || 'unknown',
        messageCount: messages.length,
        cwd: metadata?.cwd,
      },
      messages,
    }

    // Atomic write: write to temp file, then rename (same-fs rename is atomic).
    // 临时名由 atomicWriteFileSync 生成（pid + 随机后缀）—— 从前这里是固定的
    // `path + '.tmp'`，两个进程同时存同一个会话时，先 rename 的那个会把**后一个**写者的
    // 内容搬进目标，而它自己的 rename 再抛 ENOENT：在一个「目标永不半截」的函数里丢一次写。
    atomicWriteFileSync(path, JSON.stringify(session) + '\n', { mode: 0o600 })

    // Incremental index update — only touch this session's entry
    try {
      SessionStore.updateIndexEntry(name, session.metadata)
    } catch {
      // Index update is best-effort; .jsonl data is already safe
    }
  }

  /** 追加持久化一个 SessionLog（幂等：只写新事件）。缺失 session/start 时补一个。 */
  static saveLog(
    name: string,
    log: SessionLog,
    meta?: { provider?: string; model?: string; cwd?: string },
  ): void {
    ensureDir()
    const events = log.events()
    if (!events.some((e) => e.type === 'session/start')) {
      log.append({ type: 'session/start', at: Date.now(), sessionId: name, ...meta })
    }
    log.save()
    try {
      const messages = deriveMessages(log.events())
      SessionStore.updateIndexEntry(name, {
        name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        provider: meta?.provider || 'unknown',
        model: meta?.model || 'unknown',
        messageCount: messages.length,
        cwd: meta?.cwd,
      })
    } catch {
      // index 更新 best-effort
    }
  }

  /** 从磁盘重开一个 SessionLog（不存在返回空 log）。旧格式快照自动迁移为事件日志。 */
  static loadLog(name: string): SessionLog {
    const path = filePath(name)
    try {
      const raw = readRegularFileSync(path)
      if (raw === null) return SessionLog.open(name)
      const old = asStoredSnapshot(JSON.parse(raw))
      if (old) {
        // 旧格式快照 → 迁移为事件日志（重写文件，避免后续 append 混格式）
        const log = new SessionLog(name)
        log.append({
          type: 'session/start',
          at: Date.parse(old.metadata.createdAt) || Date.now(),
          sessionId: name,
          provider: old.metadata.provider,
          model: old.metadata.model,
          cwd: old.metadata.cwd,
        })
        for (const m of old.messages) for (const e of messageToEvents(m)) log.append(e)
        unlinkSync(path)
        log.save()
        return log
      }
    } catch {
      // 非旧格式（多行 JSONL 或单事件）→ 走 open
    }
    return SessionLog.open(name)
  }

  /**
   * Load a saved session. Returns null if not found or unparseable.
   */
  static load(name: string): StoredSession | null {
    const path = filePath(name)
    try {
      const raw = readRegularFileSync(path)
      if (raw !== null) {
        // 旧格式：单 JSON 对象 {metadata, messages}
        const old = asStoredSnapshot(JSON.parse(raw))
        if (old) return old
      }
    } catch {
      // 多行 JSONL → 新格式，走事件解析
    }
    return SessionStore.logToStoredSession(name, SessionLog.open(name))
  }

  private static logToStoredSession(name: string, log: SessionLog): StoredSession | null {
    const events = log.events()
    if (events.length === 0) return null
    const start = events.find((e) => e.type === 'session/start') as
      | {
          type: 'session/start'
          at: number
          sessionId: string
          provider?: string
          model?: string
          cwd?: string
        }
      | undefined
    const messages = deriveMessages(events)
    const stat = statSync(filePath(name))
    return {
      metadata: {
        name,
        createdAt: start?.at ? new Date(start.at).toISOString() : stat.mtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
        provider: start?.provider || 'unknown',
        model: start?.model || 'unknown',
        messageCount: messages.length,
        cwd: start?.cwd,
      },
      messages,
    }
  }

  /**
   * List all saved sessions, most recent first.
   *
   * 单个文件读不出来只赔上它自己 —— 这里是为**逐文件**兜底，不是给整个列表兜底：
   * 从前 try 包住整个 for 循环，第一个抛异常的文件就让 `/resume` 一条会话都不显示，
   * 而其余文件全是好的。读不出来的（坏结构、半截写、I/O 错）直接跳过：连 metadata
   * 都建不出来的会话没法在列表里表示。
   */
  static list(): SessionMetadata[] {
    ensureDir()
    try {
      const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'))
      const sessions: SessionMetadata[] = []
      for (const file of files) {
        const name = file.replace('.jsonl', '')
        let session: StoredSession | null = null
        try {
          session = SessionStore.load(name)
        } catch {
          continue
        }
        if (session?.metadata) {
          sessions.push(session.metadata)
        }
      }
      sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      return sessions
    } catch {
      return []
    }
  }

  /**
   * Delete a saved session.
   */
  static delete(name: string): boolean {
    const path = filePath(name)
    if (!existsSync(path)) return false
    try {
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * Auto-save with timestamp-based name.
   */
  static autoSave(
    messages: Message[],
    metadata?: { provider?: string; model?: string; cwd?: string },
  ): string {
    const name = `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    SessionStore.save(name, messages, metadata)
    return name
  }

  /**
   * Write .index.json with all session metadata, merging existing summary/tags.
   */
  static updateIndex(): void {
    ensureDir()
    const sessions = SessionStore.list()
    const index: SessionIndexEntry[] = sessions.map((s) => ({
      name: s.name,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      provider: s.provider,
      model: s.model,
      messageCount: s.messageCount,
      tokenCount: 0,
      cwd: s.cwd,
    }))

    // Merge with existing summaries and tags from prior index
    const existing = SessionStore.loadIndexRaw()
    for (const entry of index) {
      const prev = existing.find((e) => e.name === entry.name)
      if (prev) {
        entry.summary = prev.summary
        entry.tags = prev.tags
        entry.tokenCount = prev.tokenCount || 0
      }
    }

    atomicWriteFileSync(INDEX_FILE, JSON.stringify(index, null, 2), { mode: 0o600 })
  }

  /**
   * Incrementally update a single session's entry in the index.
   * Only modifies one entry — faster than full rebuild. Used by save().
   */
  static updateIndexEntry(name: string, metadata: SessionMetadata): void {
    ensureDir()
    const index = SessionStore.loadIndexRaw()
    const existing = index.find((e) => e.name === name)
    const entry: SessionIndexEntry = {
      name,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      provider: metadata.provider,
      model: metadata.model,
      messageCount: metadata.messageCount,
      tokenCount: existing?.tokenCount || 0,
      cwd: metadata.cwd,
      summary: existing?.summary,
      tags: existing?.tags,
    }
    if (existing) {
      Object.assign(existing, entry)
    } else {
      index.push(entry)
    }
    atomicWriteFileSync(INDEX_FILE, JSON.stringify(index, null, 2), { mode: 0o600 })
  }

  /**
   * Persist an LLM-generated summary for a session.
   * Writes a markdown file to .summaries/ and updates the index entry.
   */
  static saveSummary(name: string, summary: string, tags: string[]): void {
    ensureDir()
    mkdirSync(SUMMARIES_DIR, { recursive: true, mode: 0o700 })

    const safeRaw = name.replace(/[^a-zA-Z0-9_-]/g, '_')
    const safe =
      safeRaw.length > 100
        ? `${safeRaw.slice(0, 80)}-${createHash('sha256').update(safeRaw).digest('hex').slice(0, 16)}`
        : safeRaw
    const summaryPath = join(SUMMARIES_DIR, `${safe}.md`)
    atomicWriteFileSync(summaryPath, `# ${name}\n\n${summary}\n\nTags: ${tags.join(', ')}\n`, {
      mode: 0o600,
    })

    // Update index entry — create minimal one if not present
    try {
      const index = SessionStore.loadIndexRaw()
      const entry = index.find((e) => e.name === name)
      if (entry) {
        entry.summary = summary
        entry.tags = tags
      } else {
        index.push({
          name,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          provider: 'unknown',
          model: 'unknown',
          messageCount: 0,
          tokenCount: 0,
          summary,
          tags,
        })
      }
      atomicWriteFileSync(INDEX_FILE, JSON.stringify(index, null, 2), { mode: 0o600 })
    } catch {
      // Index write is best-effort
    }
  }

  /**
   * Return the most recent session from the index, or null if none exist.
   */
  static getLatest(): SessionIndexEntry | null {
    const index = SessionStore.loadIndexRaw()
    if (index.length > 0) {
      index.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      return index[0]!
    }
    // Fallback: scan .jsonl files directly when index is missing
    return SessionStore.scanLatestFromDisk()
  }

  /** Scan .jsonl files on disk by mtime — fallback when .index.json is missing. */
  private static scanLatestFromDisk(): SessionIndexEntry | null {
    ensureDir()
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'))
    if (files.length === 0) return null
    let latest: { name: string; mtime: number } | null = null
    for (const file of files) {
      const stat = statSync(join(SESSIONS_DIR, file))
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { name: file.replace('.jsonl', ''), mtime: stat.mtimeMs }
      }
    }
    if (!latest) return null
    // Load the session to extract metadata
    const session = SessionStore.load(latest.name)
    if (!session) return null
    return {
      name: latest.name,
      createdAt: session.metadata.createdAt,
      updatedAt: session.metadata.updatedAt,
      provider: session.metadata.provider,
      model: session.metadata.model,
      messageCount: session.metadata.messageCount,
      tokenCount: 0,
      cwd: session.metadata.cwd,
    }
  }

  /**
   * Read the raw index file, returning empty array if missing or corrupt.
   *
   * 「corrupt」不只是语法错：`null`、`{"a":1}`、`[1,2]` 都过得了 `JSON.parse`。放它们
   * 过去，`getLatest()` 会按数组用它 —— `null` 在启动路径（`index.tsx` 建系统提示时）
   * 抛 `TypeError: index.length`；`[1,2]` 更安静：`getLatest()` 返回数字 `1`，调用方接着
   * 读 `latest.name` 拿到 `undefined`，再喂给 `load()` ⇒ `name.replace` 抛。条目还必须
   * 有**字符串 name**：索引条目的第一用途就是当文件名用。
   */
  private static loadIndexRaw(): SessionIndexEntry[] {
    const raw = readRegularFileSync(INDEX_FILE)
    if (raw === null) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (e): e is SessionIndexEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as { name?: unknown }).name === 'string' &&
          (e as { name: string }).name.length > 0,
      )
    } catch {
      return []
    }
  }
}
