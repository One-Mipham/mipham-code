import type { ToolDefinition } from '../../shared/index.ts'
import { getMessageRouter } from '../../agent/message-router'

export const sendMessageTool: ToolDefinition = {
  name: 'SendMessage',
  description:
    'Send a message to another agent or session. ' +
    'Use "main" for the parent conversation, a background task ID for same-process agents, ' +
    'or a session ID for cross-session messaging (use ListAgents to discover sessions).',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description:
          'Recipient: "main" for the parent conversation, a background task ID, or a session ID for cross-session messaging.',
      },
      summary: {
        type: 'string',
        description: 'A 5-10 word summary shown as a one-line preview (max 200 chars).',
      },
      message: {
        type: 'string',
        description: 'Plain text message content.',
      },
    },
    required: ['to', 'message'],
  },
  async execute(params, ctx) {
    const to = params.to as string
    const summary = (params.summary as string) || '(no subject)'
    const message = params.message as string

    // P1-1: Truncate long summaries instead of rejecting (max 200 chars)
    const truncatedSummary = summary.length > 200 ? summary.slice(0, 197) + '...' : summary

    const from =
      ctx.sessionId === 'sub-agent'
        ? `sub-agent-${Date.now().toString(36)}`
        : ctx.sessionId || 'main'

    const router = getMessageRouter()
    const result = await router.route(from, to, truncatedSummary, message)

    if (!result.success) {
      return {
        success: false,
        content: '',
        error: `Failed to send message: ${result.error}`,
      }
    }

    const routedLabel = result.routedTo === 'bus' ? 'in-process' : 'cross-session'

    return {
      success: true,
      content:
        `── Message Sent (${routedLabel}) ──\n\n` +
        `ID:      ${result.messageId}\n` +
        `From:    ${from}\n` +
        `To:      ${to}\n` +
        `Summary: ${truncatedSummary.slice(0, 100)}`,
    }
  },
}
