import type { ToolDefinition } from '../shared/index.ts'
import { withValidation } from './validation'
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
import { listAgentsTool } from './agent/list-agents'
import { computerUseTool } from './computer/computer-use'
import { scheduleWakeupTool } from './scheduling/schedule-wakeup.js'
import { cronCreateTool, cronDeleteTool, cronListTool } from './scheduling/cron.js'

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
    withValidation(listAgentsTool),
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
