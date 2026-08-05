import type { ToolDefinition } from '../../shared/index.ts'

export const exitPlanModeTool: ToolDefinition = {
  name: 'ExitPlanMode',
  description:
    'Exit plan mode and submit your plan for approval. ' +
    'Set approved: true to switch to acceptEdits mode (code changes allowed). ' +
    'Set approved: false to revert to default mode. ' +
    'Use this after you have finished designing your approach in plan mode.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      approved: {
        type: 'boolean',
        description:
          'Whether the user approved the plan. true → switch to acceptEdits mode. false → revert to default.',
      },
    },
    required: ['approved'],
  },
  async execute(params, _ctx) {
    const approved = params.approved === true

    if (approved) {
      return {
        success: true,
        content: [
          '── Plan Approved ──',
          '',
          '✓ Exiting plan mode.',
          '✓ Switching to acceptEdits mode — reads and file edits are auto-approved.',
          '',
          'You can now implement the plan. The plan file is in .mipham/plans/.',
          '',
          'Use Shift+Tab to cycle permission modes if you need to change.',
        ].join('\n'),
      }
    }

    return {
      success: true,
      content: [
        '── Plan Mode Exited ──',
        '',
        '✓ Returning to default permission mode.',
        '',
        'No code changes were made. The plan file is preserved in .mipham/plans/.',
        'Use EnterPlanMode again when ready to resume planning.',
      ].join('\n'),
    }
  },
}
