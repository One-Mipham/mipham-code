import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition } from '../../shared/index.ts'

export const planTool: ToolDefinition = {
  name: 'Plan',
  description:
    'Enter plan mode — read-only analysis and design. Creates a structured plan file in .mipham/plans/.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Plan title (e.g., "Add user authentication")',
      },
      description: {
        type: 'string',
        description: 'Brief description of what the plan should cover',
      },
    },
  },
  async execute(params, ctx) {
    const title = (params.title as string) || 'Implementation Plan'
    const description = (params.description as string) || ''

    const planDir = join(ctx.cwd, '.mipham', 'plans')
    mkdirSync(planDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `plan-${timestamp}.md`
    const filepath = join(planDir, filename)

    const content = [
      `# ${title}`,
      '',
      `> Generated: ${new Date().toISOString()}`,
      `> Status: Draft`,
      description ? `> ${description}` : '',
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
        `── Plan Mode Activated ──`,
        ``,
        `Plan file: ${filepath}`,
        `Directory: ${planDir}`,
        ``,
        `The plan template has been created. Edit ${filename} to fill in the details.`,
        `Use /no-plan to exit plan mode.`,
        ``,
        `Plan mode is read-only — the AI will analyze and design without`,
        `executing code changes until you explicitly approve the plan.`,
      ].join('\n'),
    }
  },
}
