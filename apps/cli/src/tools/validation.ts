import { sanitizeParams } from '../shared/sanitize'
import { createT } from '../i18n-core/t'
import enUS from '../i18n-core/locales/en-US.json'
import zhCN from '../i18n-core/locales/zh-CN.json'
import type { TranslationMap } from '../i18n-core/types'
import type { ToolDefinition, ToolResult } from '../shared'

const bundles: Record<string, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}
const t = createT(bundles['en-US'] || (enUS as TranslationMap), enUS as TranslationMap)

/**
 * Coerce scalars the model sent as strings into the type the schema declares.
 *
 * Models occasionally emit `"true"` for a boolean, or `" 5 "` / `"+5"` for a
 * numeric `offset`/`limit`. Type-checking those verbatim rejected an otherwise
 * well-formed call ("expected boolean, received string"), so the model spent a
 * turn re-typing a value it had already supplied. Only the exact spellings that
 * cannot mean anything else are converted; everything else is left for
 * `validateParams` to refuse.
 */
function coerceScalars(
  schema: Record<string, unknown>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const properties = schema.properties as Record<string, { type: string }> | undefined
  if (!properties) return params
  const out = { ...params }
  for (const [key, def] of Object.entries(properties)) {
    const value = out[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (def.type === 'boolean') {
      if (trimmed === 'true') out[key] = true
      else if (trimmed === 'false') out[key] = false
    } else if (def.type === 'integer') {
      if (/^[+-]?\d+$/.test(trimmed)) out[key] = Number(trimmed)
    } else if (def.type === 'number') {
      if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) out[key] = Number(trimmed)
    }
  }
  return out
}

/**
 * Validate tool parameters against the tool's JSON Schema definition.
 * Returns an array of error messages (empty = valid).
 */
export function validateParams(
  schema: Record<string, unknown>,
  params: Record<string, unknown>,
): string[] {
  const errors: string[] = []

  const required = schema.required as string[] | undefined
  if (required) {
    for (const field of required) {
      if (params[field] === undefined || params[field] === null) {
        errors.push(t('errors.missing_param', { param: field }))
      }
    }
  }

  const properties = schema.properties as
    Record<string, { type: string; enum?: string[] }> | undefined
  if (properties) {
    for (const [key, def] of Object.entries(properties)) {
      const value = params[key]
      if (value === undefined || value === null) continue

      switch (def.type) {
        case 'string':
          if (typeof value !== 'string') errors.push(t('errors.type_string', { key }))
          else if (def.enum && !def.enum.includes(value)) {
            errors.push(t('errors.type_enum', { key, values: def.enum.join(', ') }))
          }
          break
        case 'integer':
        case 'number':
          if (typeof value !== 'number') errors.push(t('errors.type_number', { key }))
          break
        case 'boolean':
          if (typeof value !== 'boolean') errors.push(t('errors.type_boolean', { key }))
          break
        case 'object':
          if (typeof value !== 'object' || Array.isArray(value)) {
            errors.push(t('errors.type_object', { key }))
          }
          break
        case 'array':
          if (!Array.isArray(value)) errors.push(t('errors.type_array', { key }))
          break
      }
    }
  }

  return errors
}

/**
 * Wrap a tool's execute with parameter validation.
 */
export function withValidation(tool: ToolDefinition): ToolDefinition {
  const schema = tool.parameters as Record<string, unknown>
  if (!schema || !schema.properties) return tool

  return {
    ...tool,
    async execute(params, ctx): Promise<ToolResult> {
      // 参数不是合法 JSON 时，providers 交回的是 `{ _parseError, _raw }` 而不是
      // `{}`。照常校验的话，模型会读到「缺少必需参数 url」—— 一个它明明写过的
      // 参数，于是它去补参数，而不是去补那半个 JSON。先把这个事实说清楚。
      if (typeof params._parseError === 'string') {
        return {
          success: false,
          content: '',
          error: t('errors.unparseable_args', { detail: params._parseError }),
        }
      }

      const cleanParams = coerceScalars(schema, sanitizeParams(params))
      const errors = validateParams(schema, cleanParams)
      if (errors.length > 0) {
        return {
          success: false,
          content: '',
          error: t('errors.invalid_params', { errors: errors.join('; ') }),
        }
      }
      return tool.execute(cleanParams, ctx)
    },
  }
}
