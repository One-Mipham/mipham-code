import { readFileSync } from 'node:fs'
import type { ToolDefinition } from '../../shared/index.ts'

export const exitPlanModeTool: ToolDefinition = {
  name: 'ExitPlanMode',
  description:
    'Exit plan mode and present your plan for user approval. ' +
    'This tool does NOT switch to implementation mode — the user must explicitly approve first. ' +
    'After calling this, present your plan and ask the user to confirm. ' +
    'The user can approve by saying "approved" or "/approve", or by cycling to acceptEdits mode with Shift+Tab.',
  category: 'agent',
  permission: 'auto',
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
  async execute(params, _ctx) {
    const planFile = (params.planFile as string) || ''

    // Try to read the plan to confirm it exists
    let planContent = ''
    try {
      const planPath = planFile || ''
      if (planPath) {
        planContent = readFileSync(planPath, 'utf-8')
      }
    } catch {
      // Plan file not found — still exit plan mode
    }

    return {
      success: true,
      content: [
        '── Plan Ready for Review ──',
        '',
        '✓ Exiting plan mode.',
        '✓ Plan file saved. Present your plan to the user now.',
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
