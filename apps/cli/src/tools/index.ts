import type { ToolDefinition, ToolResult } from '../shared/index.ts'
import { sanitizeParams } from '../shared/sanitize'
import { createT } from '@mipham/shared/i18n/t'
import enUS from '@mipham/shared/i18n/locales/en-US.json'
import zhCN from '@mipham/shared/i18n/locales/zh-CN.json'
import type { TranslationMap } from '@mipham/shared/i18n/types'
import { readTool } from './file/read'
import { writeTool } from './file/write'
import { editTool } from './file/edit'
import { globTool } from './file/glob'
import { grepTool } from './file/grep'
import { bashTool } from './exec/bash'
import { gitTool } from './exec/git'
import { taskTool } from './exec/task'
import { enterWorktreeTool } from './exec/enter-worktree'
import { exitWorktreeTool } from './exec/exit-worktree'
import { agentTool } from './agent/agent'
import { skillTool } from './agent/skill'
import { planTool } from './agent/plan'
import { enterPlanModeTool } from './agent/enter-plan'
import { exitPlanModeTool } from './agent/exit-plan'
import { memoryTool } from './agent/memory'
import { workflowTool } from './agent/workflow'
import { webFetchTool } from './network/web-fetch'
import { webSearchTool } from './network/web-search'
import { configTool } from './system/config'
import { mcpTool } from './system/mcp'
import { toolSearchTool } from './system/tool-search'
import { artifactTool } from './artifact/artifact'
import { reportFindingsTool } from './agent/report-findings'
import { sendMessageTool } from './agent/send-message'
import { computerUseTool } from './computer/computer-use'
import { scheduleWakeupTool } from './scheduling/schedule-wakeup.js'
import { cronCreateTool, cronDeleteTool, cronListTool } from './scheduling/cron.js'

const bundles: Record<string, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}
const t = createT(bundles['en-US'] || (enUS as TranslationMap), enUS as TranslationMap)

/**
 * Validate tool parameters against the tool's JSON Schema definition.
 * Returns an array of error messages (empty = valid).
 */
function validateParams(
  schema: Record<string, unknown>,
  params: Record<string, unknown>,
): string[] {
  const errors: string[] = []

  // Check required fields
  const required = schema.required as string[] | undefined
  if (required) {
    for (const field of required) {
      if (params[field] === undefined || params[field] === null) {
        errors.push(t('errors.missing_param', { param: field }))
      }
    }
  }

  // Check types for provided fields
  const properties = schema.properties as
    Record<string, { type: string; enum?: string[] }> | undefined
  if (properties) {
    for (const [key, def] of Object.entries(properties)) {
      const value = params[key]
      if (value === undefined || value === null) continue // already caught by required check

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
function withValidation(tool: ToolDefinition): ToolDefinition {
  const schema = tool.parameters as Record<string, unknown>
  if (!schema || !schema.properties) return tool // no schema to validate against

  return {
    ...tool,
    async execute(params, ctx): Promise<ToolResult> {
      // Sanitize dangerous Unicode from all inputs
      const cleanParams = sanitizeParams(params)
      const errors = validateParams(schema, cleanParams)
      if (errors.length > 0) {
        return { success: false, content: '', error: t('errors.invalid_params', { errors: errors.join('; ') }) }
      }
      return tool.execute(cleanParams, ctx)
    },
  }
}

export function createToolRegistry(): Map<string, ToolDefinition> {
  const tools: ToolDefinition[] = [
    // File tools
    withValidation(readTool),
    withValidation(writeTool),
    withValidation(editTool),
    withValidation(globTool),
    withValidation(grepTool),
    // Exec tools
    withValidation(bashTool),
    withValidation(gitTool),
    withValidation(taskTool),
    withValidation(enterWorktreeTool),
    withValidation(exitWorktreeTool),
    // Agent tools
    withValidation(agentTool),
    withValidation(skillTool),
    withValidation(planTool),
    withValidation(enterPlanModeTool),
    withValidation(exitPlanModeTool),
    withValidation(memoryTool),
    withValidation(workflowTool),
    withValidation(reportFindingsTool),
    withValidation(sendMessageTool),
    // Network tools
    withValidation(webFetchTool),
    withValidation(webSearchTool),
    // System tools
    withValidation(configTool),
    withValidation(mcpTool),
    withValidation(toolSearchTool),
    // Artifact tools
    withValidation(artifactTool),
    // Computer Use tools
    withValidation(computerUseTool),
    // Scheduling tools
    withValidation(scheduleWakeupTool),
    withValidation(cronCreateTool),
    withValidation(cronDeleteTool),
    withValidation(cronListTool),
  ]

  const map = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    map.set(tool.name, tool)
  }
  return map
}
