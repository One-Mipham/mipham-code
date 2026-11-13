import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition } from '../../shared/index.ts'
import { MIPHAM_DIR } from '../../shared/constants.ts'

export const enterPlanModeTool: ToolDefinition = {
  name: 'EnterPlanMode',
  description:
    'Enter plan mode — a read-only mode for analysis and design. ' +
    'In plan mode, only Read/Grep/Glob tools are auto-approved; all other tools require confirmation. ' +
    'Use this before writing code to design an implementation approach, ' +
    'explore the codebase, and get user approval before executing changes.',
  category: 'agent',
  permission: 'self',
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

    // 这个工具的正文一直在说「Plan mode is READ-ONLY：其他工具都要确认」，
    // 可它从前**只写了一个 markdown 模板**，从未动过权限模式 —— 于是工具返回
    // 「已进入计划模式」，闸门还停在进这一轮之前的档位（比如 acceptEdits：
    // 写文件不问）。广告的能力没有落点，模型据此以为自己在只读档里。
    const before = ctx.permissionSystem?.getMode()
    ctx.permissionSystem?.setMode('plan')
    const live = ctx.permissionSystem?.getMode() ?? before
    const switched = live === 'plan'

    // Create plan file
    const planDir = join(ctx.cwd, MIPHAM_DIR, 'plans')
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

    const modeLine = switched
      ? 'Plan mode is READ-ONLY:'
      : `⚠️  Plan mode was NOT applied — the live permission mode is "${live ?? 'unknown'}"` +
        ' (organisation policy may forbid "plan"). Treat every write as refused until' +
        ' the user moves the mode, and say so rather than assuming read-only.'

    const readOnlyLines = switched
      ? ['  ✅ Read, Grep, Glob — auto-approved', '  ⚠️  All other tools — require confirmation']
      : []

    return {
      success: true,
      content: [
        switched ? '── Plan Mode Activated ──' : '── Plan File Created (mode unchanged) ──',
        '',
        `Plan file: ${filepath}`,
        '',
        modeLine,
        ...readOnlyLines,
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
