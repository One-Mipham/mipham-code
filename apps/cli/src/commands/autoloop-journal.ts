import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const AUTOLOOP_DIR = join(homedir(), '.mipham', 'autoloop')

function ensureDir(): void {
  if (!existsSync(AUTOLOOP_DIR)) mkdirSync(AUTOLOOP_DIR, { recursive: true })
}

interface AutoloopJournal {
  sessionId: string
  prompt: string
  status: 'active' | 'completed' | 'stopped'
  iterations: number
  startedAt: string
  lastIteration?: string
  logs: string[]
  startTokens?: number
  totalTokens: number
  maxIterations: number
}

function journalPath(sessionId: string): string {
  return join(AUTOLOOP_DIR, `${sessionId}.json`)
}

/** Create or reset an autonomous loop journal. */
export function createAutoloopJournal(
  sessionId: string,
  prompt: string,
  startTokens = 0,
): AutoloopJournal {
  ensureDir()
  const journal: AutoloopJournal = {
    sessionId,
    prompt,
    status: 'active',
    iterations: 0,
    startedAt: new Date().toISOString(),
    logs: [],
    startTokens,
    totalTokens: 0,
    maxIterations: 100,
  }
  writeFileSync(journalPath(sessionId), JSON.stringify(journal, null, 2), 'utf-8')
  return journal
}

/** Accumulate token usage into the loop journal. */
export function recordLoopTokens(sessionId: string, delta: number): void {
  const journal = readAutoloopJournal(sessionId)
  if (!journal) return
  journal.totalTokens += delta
  writeFileSync(journalPath(sessionId), JSON.stringify(journal, null, 2), 'utf-8')
}

/** Read the journal for an autonomous loop. */
export function readAutoloopJournal(sessionId: string): AutoloopJournal | null {
  const path = journalPath(sessionId)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/** Log an iteration in the autonomous loop journal. */
export function logAutoloopIteration(sessionId: string, summary: string): void {
  const journal = readAutoloopJournal(sessionId)
  if (!journal) return
  journal.iterations++
  journal.lastIteration = new Date().toISOString()
  journal.logs.push(`[${journal.lastIteration}] #${journal.iterations}: ${summary.slice(0, 200)}`)
  // Keep last 50 log entries
  if (journal.logs.length > 50) journal.logs = journal.logs.slice(-50)
  writeFileSync(journalPath(sessionId), JSON.stringify(journal, null, 2), 'utf-8')
}

/** Mark an autonomous loop as completed or stopped. */
export function completeAutoloopJournal(sessionId: string, status: 'completed' | 'stopped'): void {
  const journal = readAutoloopJournal(sessionId)
  if (!journal) return
  journal.status = status
  journal.lastIteration = new Date().toISOString()
  writeFileSync(journalPath(sessionId), JSON.stringify(journal, null, 2), 'utf-8')
}

/** List all active autonomous loops. */
export function listActiveAutoloops(): AutoloopJournal[] {
  ensureDir()
  const journals: AutoloopJournal[] = []
  for (const file of readdirSync(AUTOLOOP_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(join(AUTOLOOP_DIR, file), 'utf-8'))
      if (j.status === 'active') journals.push(j)
    } catch {
      /* skip */
    }
  }
  return journals
}

/** Get the autonomous loop status message. */
export function getAutoloopStatus(sessionId: string): string {
  const journal = readAutoloopJournal(sessionId)
  if (!journal) return 'No active autonomous loop.'
  const elapsed = Date.now() - new Date(journal.startedAt).getTime()
  const mins = Math.floor(elapsed / 60000)
  const lines = [
    `── Autonomous Loop: ${journal.sessionId} ──`,
    `Status:     ${journal.status === 'active' ? '🔄 Running' : journal.status === 'completed' ? '✅ Completed' : '⏹ Stopped'}`,
    `Prompt:     "${journal.prompt.slice(0, 100)}${journal.prompt.length > 100 ? '...' : ''}"`,
    `Iterations: ${journal.iterations}`,
    `Started:    ${journal.startedAt} (${mins}m ago)`,
    `Last:       ${journal.lastIteration || 'N/A'}`,
  ]
  if (journal.logs.length > 0) {
    lines.push('', 'Recent activity:')
    for (const log of journal.logs.slice(-5)) lines.push(`  ${log}`)
  }
  return lines.join('\n')
}
