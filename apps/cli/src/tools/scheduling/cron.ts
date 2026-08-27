import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import type { ToolDefinition } from '../../shared/index.ts'
import { computeNextFire } from '../../core/cron'

const CRON_DIR = join(homedir(), '.mipham', 'cron')

function ensureCronDir(): void {
  if (!existsSync(CRON_DIR)) mkdirSync(CRON_DIR, { recursive: true })
}

export interface CronJob {
  id: string
  cron: string
  prompt: string
  recurring: boolean
  createdAt: string
  nextFire: string
  lastFired: string | null
}

function jobPath(id: string): string {
  return join(CRON_DIR, `${id}.json`)
}

function generateId(cron: string, prompt: string): string {
  return createHash('sha256').update(`${cron}:${prompt}`).digest('hex').slice(0, 12)
}

/**
 * Read all durable cron jobs. Backfills `nextFire`/`lastFired` for files
 * written before the executor landed (they only had id/cron/prompt/recurring).
 */
export function readAllJobs(): CronJob[] {
  ensureCronDir()
  const jobs: CronJob[] = []
  for (const file of readdirSync(CRON_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(CRON_DIR, file), 'utf-8')) as Partial<CronJob>
      if (!parsed.nextFire)
        parsed.nextFire = computeNextFire(parsed.cron ?? '* * * * *', new Date())
      if (parsed.lastFired === undefined) parsed.lastFired = null
      jobs.push(parsed as CronJob)
    } catch {
      /* skip corrupt files */
    }
  }
  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Persist a job (create or update) to its JSON file. */
export function writeJob(job: CronJob): void {
  ensureCronDir()
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2), 'utf-8')
}

/** Delete a job's file. Returns false when the job did not exist. */
export function deleteJobFile(id: string): boolean {
  const path = jobPath(id)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

export const cronCreateTool: ToolDefinition = {
  name: 'CronCreate',
  description:
    'Schedule a prompt to be enqueued at a future time. Uses standard 5-field cron in local timezone. ' +
    'For recurring schedules (default): "0 9 * * *" = 9am daily. ' +
    'For one-shot: set recurring:false with pinned minute/hour/day-of-month/month. ' +
    'Durable — survives restarts, written to ~/.mipham/cron/.',
  category: 'scheduling',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      cron: {
        type: 'string',
        description:
          'Standard 5-field cron expression: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 min).',
      },
      prompt: {
        type: 'string',
        description: 'The prompt to enqueue at each fire time.',
      },
      recurring: {
        type: 'boolean',
        description:
          'true (default) = fire on every cron match. false = fire once then auto-delete.',
      },
    },
    required: ['cron', 'prompt'],
  },
  async execute(params, _ctx) {
    const cron = params.cron as string
    const prompt = params.prompt as string
    const recurring = params.recurring !== false
    const id = generateId(cron, prompt)

    const now = new Date()
    const job: CronJob = {
      id,
      cron,
      prompt: prompt.slice(0, 1000),
      recurring,
      createdAt: now.toISOString(),
      nextFire: computeNextFire(cron, now),
      lastFired: null,
    }

    writeJob(job)

    const type = recurring ? 'recurring' : 'one-shot'
    return {
      success: true,
      content:
        `Created ${type} cron job.\n` +
        `ID: ${id}\n` +
        `Schedule: ${cron}\n` +
        `Prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`,
    }
  },
}

export const cronDeleteTool: ToolDefinition = {
  name: 'CronDelete',
  description:
    'Cancel a cron job previously scheduled with CronCreate. Removes from ~/.mipham/cron/.',
  category: 'scheduling',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Job ID returned by CronCreate.',
      },
    },
    required: ['id'],
  },
  async execute(params, _ctx) {
    const id = params.id as string
    if (!deleteJobFile(id)) {
      return { success: false, content: '', error: `Cron job "${id}" not found.` }
    }
    return { success: true, content: `Cron job "${id}" deleted.` }
  },
}

export const cronListTool: ToolDefinition = {
  name: 'CronList',
  description: 'List all cron jobs scheduled via CronCreate, both durable and session-only.',
  category: 'scheduling',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_params, _ctx) {
    const jobs = readAllJobs()
    if (jobs.length === 0) {
      return {
        success: true,
        content:
          'No scheduled cron jobs.\n\n' +
          'Use CronCreate to schedule a recurring or one-shot job.\n' +
          'Use /loop <interval> <prompt> to start a recurring task.',
      }
    }

    const lines = [`── Scheduled Cron Jobs (${jobs.length}) ──`, '']
    for (const j of jobs) {
      const type = j.recurring ? 'recurring' : 'one-shot'
      lines.push(`${j.id}  ${j.cron}  ${type}`)
      lines.push(`  ${j.prompt.slice(0, 100)}`)
      lines.push('')
    }

    return { success: true, content: lines.join('\n') }
  },
}
