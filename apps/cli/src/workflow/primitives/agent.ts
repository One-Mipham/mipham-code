import { SubAgent } from '../../agent/sub-agent'
import type { ProviderRegistry } from '../../providers/registry'
import type { ToolDefinition } from '../../shared/index.ts'
import { validateJSONSchema, formatValidationErrors } from '../schema-validator'

export interface WorkflowAgentOpts {
  label?: string
  phase?: string
  schema?: object
  model?: string
  provider?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Maximum retries on schema validation failure (default: 2). */
  maxRetries?: number
}

/**
 * Workflow agent() primitive — creates a SubAgent with optional
 * provider/model override and structured output schema validation.
 *
 * When `schema` is provided:
 *   1. The sub-agent is prompted to return valid JSON matching the schema.
 *   2. The result is JSON.parsed and validated against the schema.
 *   3. On validation failure, the sub-agent is retried with error feedback.
 *   4. Returns the validated object, or { raw, validationErrors } on final failure.
 */
export async function workflowAgent(
  prompt: string,
  registry: ProviderRegistry,
  toolRegistry: Map<string, ToolDefinition>,
  opts: WorkflowAgentOpts = {},
): Promise<unknown> {
  // If provider override, switch temporarily
  if (opts.provider) {
    registry.switchProvider(opts.provider, opts.model)
  } else if (opts.model) {
    registry.switchProvider(registry.getActive().config.id, opts.model)
  }

  const maxRetries = opts.maxRetries ?? 2

  // Build the prompt — if schema is requested, instruct the model to return JSON
  let effectivePrompt = prompt
  if (opts.schema) {
    const schemaDesc = JSON.stringify(opts.schema, null, 2)
    effectivePrompt =
      `${prompt}\n\n` +
      `IMPORTANT: Your response MUST be valid JSON matching this schema:\n` +
      `\`\`\`json\n${schemaDesc}\n\`\`\`\n` +
      `Return ONLY the JSON object, no other text. Do not wrap in markdown code fences.`
  }

  const sub = new SubAgent(registry, toolRegistry)

  // ── Attempt execution with optional schema validation + retry ──
  let lastResult = ''
  let lastErrors: string[] = []

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const retryPrompt =
      attempt === 0
        ? effectivePrompt
        : `${effectivePrompt}\n\n` +
          `[RETRY #${attempt}] Your previous response did NOT match the required schema.\n` +
          `Validation errors:\n${lastErrors.map((e) => `  • ${e}`).join('\n')}\n\n` +
          `Please fix the errors and return a valid JSON object matching the schema exactly.`

    const result = await sub.execute(retryPrompt, opts.label || 'workflow-agent', {
      type: 'general',
      modelOverride: opts.model,
      allowedTools: undefined, // use all tools by default
    })

    lastResult = result

    // No schema — return raw result
    if (!opts.schema) {
      return result
    }

    // Try to parse and validate
    try {
      // Extract JSON from potential markdown fences
      let jsonStr = result.trim()
      const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (fenceMatch) {
        jsonStr = fenceMatch[1]!.trim()
      }

      const parsed = JSON.parse(jsonStr)
      const errors = validateJSONSchema(parsed, opts.schema as Record<string, unknown>)

      if (errors.length === 0) {
        // Valid! Return the parsed object
        return parsed
      }

      // Not valid — collect errors for retry
      lastErrors = [formatValidationErrors(errors)]
    } catch (err) {
      // JSON parse error
      lastErrors = [`JSON parse error: ${String(err)}. Ensure your response is valid JSON only.`]
    }
  }

  // All retries exhausted — return raw result with validation errors
  try {
    const parsed = JSON.parse(lastResult)
    return { raw: lastResult, parsed, validationErrors: lastErrors }
  } catch {
    return { raw: lastResult, validationErrors: lastErrors }
  }
}
