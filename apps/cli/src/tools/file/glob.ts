import { Glob } from 'bun'
import type { ToolDefinition } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'

export const globTool: ToolDefinition = {
  name: 'Glob',
  description: 'Find files matching a glob pattern.',
  category: 'file',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "src/**/*.ts")' },
      path: { type: 'string', description: 'Base directory' },
    },
    required: ['pattern'],
  },
  async execute(params, ctx) {
    const pattern = params.pattern as string
    const basePath = resolveSafe(ctx.cwd, (params.path as string) || '.')
    const glob = new Glob(pattern)
    const results: string[] = []
    for await (const file of glob.scan({ cwd: basePath, absolute: true })) {
      results.push(file)
      if (results.length >= 500) break
    }
    return { success: true, content: results.join('\n') || '(no matches)' }
  },
}
