import type { Context, Service } from '../vajra'
import type { ToolDefinition } from '../shared'

/** 工具服务键前缀。一个已挂载工具以 `tool:<name>` 注册于 Context。 */
export const toolKey = (name: string): string => `tool:${name}`

/** 把普通 ToolDefinition 包装成 Vajra Service（无注入依赖）。 */
export function toolService(tool: ToolDefinition): Service {
  return {
    apply(ctx) {
      ctx.provide(toolKey(tool.name), tool)
    },
  }
}

/** 从 Context 已挂载的工具服务派生 name → definition 的 Map（engine 消费）。 */
export function collectTools(ctx: Context): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>()
  for (const key of ctx.keysRecursive()) {
    if (!key.startsWith('tool:')) continue
    const tool = ctx.get<ToolDefinition>(key)
    if (tool) map.set(tool.name, tool)
  }
  return map
}
