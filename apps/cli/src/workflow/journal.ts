import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { appendRegularFileSync, readRegularFileSync } from '../shared/regular-file'
import { miphamHome } from '../core/paths.ts'

const WORKFLOW_DIR = miphamHome('workflows')

export interface JournalEntry {
  seq: number
  type: 'agent' | 'phase' | 'log'
  prompt?: string
  opts?: Record<string, unknown>
  result?: unknown
  message?: string
}

export interface JournalState {
  seq: number
  phases: string[]
}

/**
 * Create a journal for a workflow run.
 * Returns the path to the run directory.
 */
export function createJournal(runId: string, script: string): string {
  const dir = join(WORKFLOW_DIR, runId)
  mkdirSync(dir, { recursive: true })

  // 三份都走助手：新建 run 目录里本来没有旧内容可丢，但**路径上可能被放了个 FIFO**
  // （`writeFileSync` 会打开它写 ⇒ 干等到有读者为止）。`atomicWriteFileSync` 的 rename
  // 与 `appendRegularFileSync` 的类型闸都不打开目标，于是在这里也一并关掉。
  atomicWriteFileSync(join(dir, 'script.js'), script, { mode: 0o644 })
  if (!appendRegularFileSync(join(dir, 'journal.jsonl'), '')) {
    throw new Error(`workflow journal for run "${runId}" is not appendable`)
  }
  atomicWriteFileSync(join(dir, 'state.json'), JSON.stringify({ seq: 0, phases: [] }))

  return dir
}

/**
 * Append an agent call to the journal. Returns the new sequence number.
 *
 * 先 append journal（权威记录）、后写 state（它的影子）—— 顺序有意义：中途被打断时
 * 唯一的后果是影子落后，而不是记录丢失。
 */
export function appendJournal(runId: string, entry: Omit<JournalEntry, 'seq'>): number {
  const dir = join(WORKFLOW_DIR, runId)
  const state = readState(runId)

  const seq = state.seq + 1
  const fullEntry: JournalEntry = { seq, ...entry }

  // 权威记录写不进去 = 这个 run 没法记账（含路径上是个 FIFO）：**不做影子**、当场说清，
  // 好过把 state 推进到一个 journal 里不存在的 seq 上。
  if (!appendRegularFileSync(join(dir, 'journal.jsonl'), JSON.stringify(fullEntry) + '\n')) {
    throw new Error(`workflow journal for run "${runId}" is not appendable`)
  }

  state.seq = seq
  atomicWriteFileSync(join(dir, 'state.json'), JSON.stringify(state))

  return seq
}

/**
 * Load all journal entries for a run. Returns empty array if run not found.
 *
 * **逐行**解析：`appendFileSync` 被打断会在尾部留下半截行，而从前一个半截行让整份
 * 读取抛 `SyntaxError`（`/workflow` 那条链上没有兜它）。坏行丢掉、其余全留 —— 一份
 * 日志里少一行，好过整份读不出来。
 */
export function loadJournal(runId: string): JournalEntry[] {
  const raw = readRegularFileSync(join(WORKFLOW_DIR, runId, 'journal.jsonl'))
  if (raw === null) return []

  const entries: JournalEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isJournalEntry(parsed)) entries.push(parsed)
    } catch {
      // 半截行（append 被打断）/坏行 —— 只丢这一行
    }
  }
  return entries
}

function isJournalEntry(e: unknown): e is JournalEntry {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false
  const ev = e as Record<string, unknown>
  return (
    typeof ev.seq === 'number' && (ev.type === 'agent' || ev.type === 'phase' || ev.type === 'log')
  )
}

/**
 * 读 state.json。
 *
 * 从前这里是**裸**的 `JSON.parse(readFileSync(...))`：state.json 是非原子写的，半截写
 * 会让 `appendJournal` 当场抛 `SyntaxError`，整个 run 停摆 —— 而 state 只是**派生**信息。
 * 所以坏掉/缺字段时把 `seq` 从 journal 尾行**重新推出来**，而不是归零：归零会让后续
 * append 复用已经在用的序号，而那正是这份文件存在的意义。
 */
function readState(runId: string): JournalState {
  const raw = readRegularFileSync(join(WORKFLOW_DIR, runId, 'state.json'))
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const { seq, phases } = parsed as { seq?: unknown; phases?: unknown }
        if (typeof seq === 'number' && Number.isFinite(seq)) {
          return {
            seq,
            phases: Array.isArray(phases)
              ? phases.filter((p): p is string => typeof p === 'string')
              : [],
          }
        }
      }
    } catch {
      // 半截写/坏形状 —— 落到下面按 journal 推。
    }
  }
  return { seq: lastJournalSeq(runId), phases: [] }
}

/** journal 尾行的 seq —— 权威记录在 journal.jsonl，state.json 只是它的影子。 */
function lastJournalSeq(runId: string): number {
  return loadJournal(runId).reduce((max, e) => (e.seq > max ? e.seq : max), 0)
}

/**
 * Load the saved script for a run. Returns empty string if not found.
 */
export function loadScript(runId: string): string {
  const scriptPath = join(WORKFLOW_DIR, runId, 'script.js')
  return readRegularFileSync(scriptPath) ?? ''
}

/**
 * List all workflow run IDs.
 */
export function listRuns(): string[] {
  if (!existsSync(WORKFLOW_DIR)) return []
  return readdirSync(WORKFLOW_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
}

/**
 * Get the journal directory path for a run.
 */
export function getRunDir(runId: string): string {
  return join(WORKFLOW_DIR, runId)
}
