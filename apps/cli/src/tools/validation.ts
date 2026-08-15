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
      const cleanParams = sanitizeParams(params)
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
