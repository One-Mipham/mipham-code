import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition } from '../../shared/index.ts'
import { MIPHAM_DIR } from '../../shared/constants.ts'

/**
 * Newest `plan-*.md` under `<cwd>/.mipham/plans/`, or null when there is none.
 *
 * This backs the `planFile` parameter's documented default. Without it the
 * docstring promised a fallback the body never performed (`planFile || ''`), so an
 * omission read as "use the most recent plan" and quietly produced no plan at all.
 */
function mostRecentPlanFile(cwd: string): string | null {
  const dir = join(cwd, MIPHAM_DIR, 'plans')
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.startsWith('plan-') && n.endsWith('.md'))
  } catch {
    return null // no plans directory — nothing to fall back to
  }
  let newest: { path: string; mtime: number } | null = null
  for (const name of names) {
    const path = join(dir, name)
    try {
      const mtime = statSync(path).mtimeMs
      if (!newest || mtime > newest.mtime) newest = { path, mtime }
    } catch {
      // Unreadable entry — not a fallback candidate.
    }
  }
  return newest?.path ?? null
}

export const exitPlanModeTool: ToolDefinition = {
  name: 'ExitPlanMode',
  description:
    'Exit plan mode and present your plan for user approval. ' +
    'This tool does NOT switch to implementation mode — the user must explicitly approve first. ' +
    'After calling this, present your plan and ask the user to confirm. ' +
    'The user can approve by saying "approved" or "/approve", or by cycling to acceptEdits mode with Shift+Tab.',
  category: 'agent',
  permission: 'self',
  parameters: {
    type: 'object',
    properties: {
      planFile: {
        type: 'string',
        description:
          'Path to the plan file you wrote (e.g., .mipham/plans/plan-2026-08-10T12-00-00.md). If omitted, the most recent plan file is used.',
      },
    },
    required: [],
  },
  async execute(params, ctx) {
    const planFile = (params.planFile as string) || mostRecentPlanFile(ctx.cwd) || ''

    // Try to read the plan to confirm it exists
    let planContent = ''
    let readError = ''
    try {
      if (planFile) {
        planContent = readFileSync(planFile, 'utf-8')
      }
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err)
    }

    // Say which of the three states we are actually in. The old text asserted
    // "Plan file saved" unconditionally, so a missing or unreadable plan still read
    // as success and the model would present a plan it never retrieved.
    const planStatus = planContent
      ? '✓ Plan file read. Present your plan to the user now.'
      : planFile
        ? `⚠️  Plan file not readable (${planFile}): ${readError}`
        : '⚠️  No plan file found — present the plan from your own context.'

    return {
      success: true,
      content: [
        '── Plan Ready for Review ──',
        '',
        '✓ Exiting plan mode.',
        planStatus,
        planFile ? `Plan file: ${planFile}` : '',
        '',
        '⚠️  IMPORTANT: You are still in limited permission mode.',
        '    The user must explicitly approve before you can make changes.',
        '',
        'Next steps:',
        '  1. Present your plan to the user (summarize key decisions)',
        '  2. Ask: "Does this plan look good? Reply approved to begin."',
        '  3. Wait for the user to explicitly say "approved" or "/approve"',
        '  4. Only then switch to acceptEdits mode (Shift+Tab or user action)',
        '',
        'DO NOT start implementing until the user explicitly approves.',
        'DO NOT call ExitPlanMode with approved:true — that parameter no longer exists.',
        planContent ? `\n── Plan Content (for reference) ──\n\n${planContent.slice(0, 3000)}` : '',
      ].join('\n'),
    }
  },
}
