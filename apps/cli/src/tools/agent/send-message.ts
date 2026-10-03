import type { ToolDefinition } from '../../shared/index.ts'
import { getMessageRouter } from '../../agent/message-router'

export const sendMessageTool: ToolDefinition = {
  name: 'SendMessage',
  description:
    'Send a message to another agent or session. ' +
    'Use "main" for the parent conversation, a background task ID for same-process agents, ' +
    'or a session ID (or unique session name) for cross-session messaging (use ListAgents to discover sessions).',
  category: 'agent',
  permission: 'self',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description:
          'Recipient: "main" for the parent conversation, a background task ID, or a session ID / unique session name for cross-session messaging.',
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

    // Prefer the agent's own name when it has one (a sub-agent gets it from
    // `SubAgent.runExecution`): `sessionId` is the literal 'sub-agent' for every
    // sub-agent, so keying off it alone gave the parent an opaque sender — and one
    // minted per message, so two messages from the same agent could not be grouped
    // or replied to. Callers with no identity (the main session) keep the previous
    // shape byte-for-byte.
    const from =
      ctx.agentName ||
      (ctx.sessionId === 'sub-agent'
        ? `sub-agent-${Date.now().toString(36)}`
        : ctx.sessionId || 'main')

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

    const body =
      `ID:      ${result.messageId}\n` +
      `From:    ${from}\n` +
      `To:      ${to}\n` +
      `Summary: ${truncatedSummary.slice(0, 100)}`

    // A cross-session message written to the inbox of a session that holds
    // inbound messages has NOT been delivered — that session's user decides
    // first, and may decline. Reporting "Sent" there tells the sender to expect
    // a reply to a message that was never read. Name the session holding it.
    if (result.routedTo === 'inbox' && result.held) {
      const who = result.targetName ?? to
      return {
        success: true,
        content:
          `── Message Queued (${routedLabel}) ──\n\n` +
          `Not yet delivered: "${who}" holds inbound messages for approval. ` +
          `It will see this only if it accepts.\n\n` +
          body,
      }
    }

    return {
      success: true,
      content: `── Message Sent (${routedLabel}) ──\n\n${body}`,
    }
  },
}
