import type { ToolDefinition } from '@mipham/shared'
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

export function createToolRegistry(): Map<string, ToolDefinition> {
  const tools: ToolDefinition[] = [
    // File tools
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    // Exec tools
    bashTool,
    gitTool,
    taskTool,
    // Agent tools
    agentTool,
    skillTool,
    planTool,
    memoryTool,
    // Network tools
    webFetchTool,
    webSearchTool,
    // System tools
    configTool,
    mcpTool,
  ]

  const map = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    map.set(tool.name, tool)
  }
  return map
}
