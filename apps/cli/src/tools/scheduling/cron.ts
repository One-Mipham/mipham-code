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

const CRON_DIR = join(homedir(), '.mipham', 'cron')

function ensureCronDir(): void {
  if (!existsSync(CRON_DIR)) mkdirSync(CRON_DIR, { recursive: true })
}

interface CronJob {
  id: string
  cron: string
  prompt: string
  recurring: boolean
  createdAt: string
}

function jobPath(id: string): string {
  return join(CRON_DIR, `${id}.json`)
}

function generateId(cron: string, prompt: string): string {
  return createHash('sha256').update(`${cron}:${prompt}`).digest('hex').slice(0, 12)
}

function readAllJobs(): CronJob[] {
  ensureCronDir()
  const jobs: CronJob[] = []
  for (const file of readdirSync(CRON_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      jobs.push(JSON.parse(readFileSync(join(CRON_DIR, file), 'utf-8')))
    } catch {
      /* skip corrupt files */
    }
  }
  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
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

    ensureCronDir()

    const job: CronJob = {
      id,
      cron,
      prompt: prompt.slice(0, 1000),
      recurring,
      createdAt: new Date().toISOString(),
    }

    writeFileSync(jobPath(id), JSON.stringify(job, null, 2), 'utf-8')

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
    const path = jobPath(id)
    if (!existsSync(path)) {
      return { success: false, content: '', error: `Cron job "${id}" not found.` }
    }
    unlinkSync(path)
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
