import { $ } from 'bun'
import type { ToolDefinition } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'

export const grepTool: ToolDefinition = {
  name: 'Grep',
  description: 'Search file contents using ripgrep. Fast regex search across files.',
  category: 'file',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search in' },
      include: { type: 'string', description: 'File pattern to include (e.g., "*.ts")' },
    },
    required: ['pattern'],
  },
  async execute(params, ctx) {
    const pattern = params.pattern as string
    const searchPath = resolveSafe(ctx.cwd, (params.path as string) || '.')
    const include = params.include as string | undefined

    try {
      const args = ['-n', '--heading', '--color=never', '-M', '500', pattern]
      if (include) args.push('--glob', include)
      args.push(searchPath)

      const result = await $`rg ${args}`.cwd(ctx.cwd).quiet().text()
      return { success: true, content: result || '(no matches)' }
    } catch (err: unknown) {
      const exitErr = err as { exitCode?: number }
      if (exitErr.exitCode === 1) {
        return { success: true, content: '(no matches)' }
      }
      // Fallback to grep
      try {
        const content = await $`grep -rn ${pattern} ${searchPath}`.cwd(ctx.cwd).quiet().text()
        return {
          success: true,
          content: content.slice(0, 50000) || '(no matches)',
        }
      } catch {
        return {
          success: false,
          content: '',
          error: 'grep failed. Install ripgrep: brew install ripgrep',
        }
      }
    }
  },
}
