import type { ToolDefinition } from '../../shared/index.ts'
import { getMessageBus } from '../../agent/message-bus'

export const sendMessageTool: ToolDefinition = {
  name: 'SendMessage',
  description:
    'Send a message to another agent or the main conversation. ' +
    'Use "main" as the recipient to message the parent session, ' +
    'or a background task ID (e.g., "bg-1-xxx") to message a specific agent. ' +
    'Messages are stored in the AgentMessageBus and can be polled by the recipient.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description:
          'Recipient: "main" for the parent conversation, a background task ID, or an agent name.',
      },
      summary: {
        type: 'string',
        description:
          'A 5-10 word summary shown as a one-line preview (max 200 chars).',
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

    // Determine sender: use sessionId or 'main'
    const from = ctx.sessionId === 'sub-agent'
      ? `sub-agent-${Date.now().toString(36)}`
      : ctx.sessionId || 'main'

    try {
      const bus = getMessageBus()
      const msgId = bus.post(from, to, summary, message)

      const unreadForRecipient = bus.unreadCount(to)

      return {
        success: true,
        content:
          `── Message Sent ──\n\n` +
          `ID:      ${msgId}\n` +
          `From:    ${from}\n` +
          `To:      ${to}\n` +
          `Summary: ${summary.slice(0, 100)}\n\n` +
          `The recipient has ${unreadForRecipient} unread message(s).`,
      }
    } catch (err) {
      return {
        success: false,
        content: '',
        error: `Failed to send message: ${String(err)}`,
      }
    }
  },
}
