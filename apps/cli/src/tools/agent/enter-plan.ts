import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition } from '../../shared/index.ts'

export const enterPlanModeTool: ToolDefinition = {
  name: 'EnterPlanMode',
  description:
    'Enter plan mode — a read-only mode for analysis and design. ' +
    'In plan mode, only Read/Grep/Glob tools are auto-approved; all other tools require confirmation. ' +
    'Use this before writing code to design an implementation approach, ' +
    'explore the codebase, and get user approval before executing changes.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description:
          'Brief description of what you are planning (e.g., "Add user authentication flow")',
      },
    },
    required: [],
  },
  async execute(params, ctx) {
    const description = (params.description as string) || 'Implementation Plan'

    // Create plan file
    const planDir = join(ctx.cwd, '.mipham', 'plans')
    mkdirSync(planDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `plan-${timestamp}.md`
    const filepath = join(planDir, filename)

    const content = [
      `# ${description}`,
      '',
      `> Generated: ${new Date().toISOString()}`,
      `> Status: Draft`,
      '',
      '## Overview',
      '',
      '[Describe what this plan aims to achieve]',
      '',
      '## Files to Modify',
      '',
      '| File | Change | Reason |',
      '|------|--------|--------|',
      '|      |        |        |',
      '',
      '## Implementation Steps',
      '',
      '1. ',
      '2. ',
      '3. ',
      '',
      '## Verification',
      '',
      '- [ ] Tests pass',
      '- [ ] Typecheck passes',
      '- [ ] Manual verification',
      '',
      '## Notes',
      '',
      '[Any additional context, risks, or dependencies]',
    ].join('\n')

    writeFileSync(filepath, content, 'utf-8')

    return {
      success: true,
      content: [
        '── Plan Mode Activated ──',
        '',
        `Plan file: ${filepath}`,
        '',
        'Plan mode is READ-ONLY:',
        '  ✅ Read, Grep, Glob — auto-approved',
        '  ⚠️  All other tools — require confirmation',
        '',
        'Design your approach, explore the codebase, then:',
        '  • Use ExitPlanMode to submit your plan for user review',
        '  • Present your plan and ask for explicit approval',
        '  • The user must say "approved" before you switch to acceptEdits mode',
        '',
        '⚠️  You CANNOT self-approve your plan. The user must explicitly confirm.',
        '    After ExitPlanMode, wait for user approval before making code changes.',
      ].join('\n'),
    }
  },
}
