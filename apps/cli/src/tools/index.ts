import type { ToolDefinition, ToolResult } from '../shared/index.ts'
import { readTool } from './file/read'
import { writeTool } from './file/write'
import { editTool } from './file/edit'
import { globTool } from './file/glob'
import { grepTool } from './file/grep'
import { bashTool } from './exec/bash'
import { gitTool } from './exec/git'
import { taskTool } from './exec/task'
import { agentTool } from './agent/agent'
import { skillTool } from './agent/skill'
import { planTool } from './agent/plan'
import { memoryTool } from './agent/memory'
import { webFetchTool } from './network/web-fetch'
import { webSearchTool } from './network/web-search'
import { configTool } from './system/config'
import { mcpTool } from './system/mcp'

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
        errors.push(`Missing required parameter: "${field}"`)
      }
    }
  }

  // Check types for provided fields
  const properties = schema.properties as Record<string, { type: string; enum?: string[] }> | undefined
  if (properties) {
    for (const [key, def] of Object.entries(properties)) {
      const value = params[key]
      if (value === undefined || value === null) continue // already caught by required check

      switch (def.type) {
        case 'string':
          if (typeof value !== 'string') errors.push(`"${key}" must be a string`)
          else if (def.enum && !def.enum.includes(value)) {
            errors.push(`"${key}" must be one of: ${def.enum.join(', ')}`)
          }
          break
        case 'integer':
        case 'number':
          if (typeof value !== 'number') errors.push(`"${key}" must be a number`)
          break
        case 'boolean':
          if (typeof value !== 'boolean') errors.push(`"${key}" must be a boolean`)
          break
        case 'object':
          if (typeof value !== 'object' || Array.isArray(value)) {
            errors.push(`"${key}" must be an object`)
          }
          break
        case 'array':
          if (!Array.isArray(value)) errors.push(`"${key}" must be an array`)
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
      const errors = validateParams(schema, params)
      if (errors.length > 0) {
        return { success: false, content: '', error: `Invalid parameters: ${errors.join('; ')}` }
      }
      return tool.execute(params, ctx)
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
    // Agent tools
    withValidation(agentTool),
    withValidation(skillTool),
    withValidation(planTool),
    withValidation(memoryTool),
    // Network tools
    withValidation(webFetchTool),
    withValidation(webSearchTool),
    // System tools
    withValidation(configTool),
    withValidation(mcpTool),
  ]

  const map = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    map.set(tool.name, tool)
  }
  return map
}
