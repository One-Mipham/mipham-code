import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
  readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const WORKFLOW_DIR = join(homedir(), '.mipham', 'workflows')

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

  writeFileSync(join(dir, 'script.js'), script, 'utf-8')
  writeFileSync(join(dir, 'journal.jsonl'), '', 'utf-8')
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ seq: 0, phases: [] }), 'utf-8')

  return dir
}

/**
 * Append an agent call to the journal. Returns the new sequence number.
 */
export function appendJournal(runId: string, entry: Omit<JournalEntry, 'seq'>): number {
  const dir = join(WORKFLOW_DIR, runId)
  const state = readState(runId)

  const seq = state.seq + 1
  const fullEntry: JournalEntry = { seq, ...entry }

  appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify(fullEntry) + '\n', 'utf-8')

  state.seq = seq
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state), 'utf-8')

  return seq
}

/**
 * Load all journal entries for a run. Returns empty array if run not found.
 */
export function loadJournal(runId: string): JournalEntry[] {
  const journalPath = join(WORKFLOW_DIR, runId, 'journal.jsonl')
  if (!existsSync(journalPath)) return []

  const raw = readFileSync(journalPath, 'utf-8')
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JournalEntry)
}

function readState(runId: string): JournalState {
  const statePath = join(WORKFLOW_DIR, runId, 'state.json')
  if (!existsSync(statePath)) return { seq: 0, phases: [] }
  return JSON.parse(readFileSync(statePath, 'utf-8'))
}

/**
 * Load the saved script for a run. Returns empty string if not found.
 */
export function loadScript(runId: string): string {
  const scriptPath = join(WORKFLOW_DIR, runId, 'script.js')
  if (!existsSync(scriptPath)) return ''
  return readFileSync(scriptPath, 'utf-8')
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
