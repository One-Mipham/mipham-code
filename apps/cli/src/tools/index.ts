import type { ToolDefinition } from '../shared/index.ts'
import { Context } from '../vajra'
import { withValidation } from './validation'
import { toolService, collectTools } from './seam'
import { readToolService } from './file/read'
import { writeTool } from './file/write'
import { editTool } from './file/edit'
import { globToolService } from './file/glob'
import { grepToolService } from './file/grep'
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
import { loadUserCredentialMaskingConfig } from '../config/loader'

function defaultVajraContext(): Context {
  const ctx = new Context()
  // Fail-closed 默认：无参调用（daemon / workflow）拿到的是**用户级**掩码策略，
  // 且配置读不出来时留下的是默认值（掩码开），不是一块关掉的掩码。
  //
  // 原先给的是 DISABLED 配置，理由是「对齐 pre-seam 行为」—— 但掩码是安全控制，
  // 「没配置就关掉」是把默认值的方向定反了：daemon 里 Read/Bash/Grep/Glob 的
  // 掩码整套失效，子进程继承完整 process.env、输出不擦洗。
  //
  // 只取用户级、不取项目级：注册表是 daemon 进程级的一个实例而会话 cwd 各不相同
  // （见 `loadUserCredentialMaskingConfig` 的注释），把某个项目的段套上去等于让它溢到
  // 别的会话。交互式 CLI 走 index.tsx 自己的 ctx（含项目级），不经过这里。
  ctx.provide('credentials', loadUserCredentialMaskingConfig())
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
  // 注入工具（credentials 依赖）：read + bash + grep + glob
  ctx.mount(readToolService)
  ctx.mount(bashToolService)
  ctx.mount(grepToolService)
  ctx.mount(globToolService)

  return collectTools(ctx)
}
