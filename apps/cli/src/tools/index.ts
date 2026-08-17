import type { ToolDefinition } from '../shared/index.ts'
import { Context } from '../vajra'
import { withValidation } from './validation'
import { toolService, collectTools } from './seam'
import { readToolService } from './file/read'
import { writeTool } from './file/write'
import { editTool } from './file/edit'
import { globTool } from './file/glob'
import { grepTool } from './file/grep'
import { bashToolService } from './exec/bash'
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
import { DISABLED_CREDENTIAL_MASKING_CONFIG } from '../config/defaults'

function defaultVajraContext(): Context {
  const ctx = new Context()
  // 掩码中立默认：无参调用（daemon/workflow）保持 Read/Bash 挂载，但不启用掩码，
  // 对齐 pre-seam 行为（那些路径从不调用 setter）。显式开启掩码走 index.tsx 的加载配置。
  ctx.provide('credentials', DISABLED_CREDENTIAL_MASKING_CONFIG)
  return ctx
}

export function createToolRegistry(
  ctx: Context = defaultVajraContext(),
): Map<string, ToolDefinition> {
  // 普通工具：包 withValidation 后作为 Service 挂载
  const plainTools: ToolDefinition[] = [
    // File tools
    writeTool,
    editTool,
    globTool,
    grepTool,
    // Exec tools
    gitTool,
    taskTool,
    enterWorktreeTool,
    exitWorktreeTool,
    // Agent tools
    agentTool,
    skillTool,
    planTool,
    enterPlanModeTool,
    exitPlanModeTool,
    memoryTool,
    workflowTool,
    reportFindingsTool,
    sendMessageTool,
    listAgentsTool,
    // Network tools
    webFetchTool,
    webSearchTool,
    // System tools
    configTool,
    mcpTool,
    toolSearchTool,
    // Artifact tools
    artifactTool,
    // Computer Use tools
    computerUseTool,
    // Scheduling tools
    scheduleWakeupTool,
    cronCreateTool,
    cronDeleteTool,
    cronListTool,
  ]
  for (const tool of plainTools) {
    ctx.mount(toolService(withValidation(tool)))
  }
  // 注入工具（credentials 依赖）：read + bash
  ctx.mount(readToolService)
  ctx.mount(bashToolService)

  return collectTools(ctx)
}
