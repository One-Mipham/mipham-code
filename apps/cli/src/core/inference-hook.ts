import { createHmac, randomUUID } from 'node:crypto'
import type {
  InferenceHookConfig,
  InferenceCheckRequest,
  InferenceCheckResponse,
  Message,
} from '../shared/index.ts'

// ── Result type ──

export interface InferenceVerdict {
  allowed: boolean
  reason?: string
}

// ── Public API ──

/**
 * Build the inference-check request payload from current conversation state.
 *
 * Follows Claude Inference Hooks protocol:
 * - Sends all messages EXCEPT system role (never expose system prompts)
 * - Includes recent tool calls with result previews (truncated to 2000 chars)
 * - Omits tool definitions and raw file/image content
 */
export function buildRequest(
  messages: Message[],
  sessionId: string,
  provider: string,
  model: string,
  organizationId?: string,
): InferenceCheckRequest {
  // Filter: exclude system messages, flatten content blocks to text
  const serialized: Array<{ role: string; content: string }> = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    serialized.push({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    })
  }

  // Extract tool calls from the message history
  const toolCalls = extractToolCalls(messages)

  return {
    type: 'inference_check',
    id: `evt_${randomUUID()}`,
    created_at: new Date().toISOString(),
    data: {
      type: 'pre_inference',
      session_id: sessionId,
      organization_id: organizationId || undefined,
      provider,
      model,
      messages: serialized,
      tool_calls: toolCalls,
    },
  }
}

/**
 * Send the inference-check request to the DLP server and return the verdict.
 *
 * On network error or timeout, applies the configured `on_failure` strategy:
 * - 'fail-closed': block the request (security-first)
 * - 'fail-open': allow the request (availability-first)
 */
export async function sendInferenceCheck(
  config: InferenceHookConfig,
  request: InferenceCheckRequest,
): Promise<InferenceVerdict> {
  const body = JSON.stringify(request)

  // Build signature header
  const signature = signPayload(config.signing_secret, body)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `MiphamCode/${getVersion()}`,
    ...(config.headers || {}),
  }

  if (signature) {
    headers['X-Mipham-Signature'] = signature
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(config.timeout),
    })

    const responseBody = await response.text()

    if (response.status === 200) {
      // Parse verdict — treat any non-deny as allow
      try {
        const parsed = JSON.parse(responseBody) as InferenceCheckResponse
        if (parsed.verdict === 'deny') {
          return { allowed: false, reason: parsed.reason || 'Blocked by DLP policy' }
        }
        return { allowed: true }
      } catch {
        // Unparseable response — treat as allow (server acknowledged receipt)
        return { allowed: true }
      }
    }

    // 403 = explicit deny
    if (response.status === 403) {
      try {
        const parsed = JSON.parse(responseBody) as InferenceCheckResponse
        return { allowed: false, reason: parsed.reason || 'Blocked by DLP policy' }
      } catch {
        return { allowed: false, reason: `DLP server denied (403): ${responseBody.slice(0, 200)}` }
      }
    }

    // Other non-2xx: apply failure posture
    if (config.on_failure === 'fail-closed') {
      return {
        allowed: false,
        reason: `DLP server returned ${response.status}: ${responseBody.slice(0, 200)}`,
      }
    }
    return { allowed: true }
  } catch (err) {
    // Network error or timeout
    if (config.on_failure === 'fail-closed') {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        allowed: false,
        reason: `DLP server unreachable: ${msg}`,
      }
    }
    // fail-open: allow through
    return { allowed: true }
  }
}

/**
 * Check if inference hook is configured and should be used.
 */
export function isInferenceHookEnabled(config?: InferenceHookConfig): boolean {
  return !!(config?.endpoint && config.endpoint.length > 0)
}

// ── Internal helpers ──

/**
 * Extract tool calls and their results from the entire message history.
 * Scans for tool_use/tool_result pairs across all messages.
 * Each result_preview is truncated to 2000 characters.
 */
function extractToolCalls(
  messages: Message[],
): Array<{ name: string; input: Record<string, unknown>; result_preview: string }> {
  // Collect tool results first (keyed by tool_use_id)
  const toolResults = new Map<string, string>()
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResults.set(block.tool_use_id, block.content || '')
        }
      }
    }
  }

  // Extract tool_use blocks with their result previews
  const calls: Array<{
    name: string
    input: Record<string, unknown>
    result_preview: string
  }> = []

  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          const resultPreview = toolResults.get(block.id) || ''
          calls.push({
            name: block.name,
            input: block.input,
            result_preview: resultPreview.slice(0, 2000),
          })
        }
      }
    }
  }

  return calls
}

/**
 * Sign the request body using HMAC-SHA256.
 * Follows Standard Webhooks specification:
 *   X-Mipham-Signature: t=<unix_timestamp>,v1=<hmac_sha256_hex>
 * Returns empty string if no signing secret is configured.
 */
function signPayload(secret: string, body: string): string {
  if (!secret) return ''
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signedPayload = `${timestamp}.${body}`
  const signature = createHmac('sha256', secret).update(signedPayload).digest('hex')
  return `t=${timestamp},v1=${signature}`
}

/**
 * Get the current package version for the User-Agent header.
 */
function getVersion(): string {
  try {
    // Dynamic import to avoid circular deps — the shared package-info
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version?: string }
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}
