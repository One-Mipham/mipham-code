import { Glob } from 'bun'
import type { ToolDefinition, CredentialMaskingConfig } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'
import type { Service } from '../../vajra'
import { toolKey } from '../seam'
import { withValidation } from '../validation'
import { maskGlobOutput } from '../../core/credential-masker'

export function createGlobTool(credentialConfig?: CredentialMaskingConfig): ToolDefinition {
  return {
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
      const content = results.join('\n') || '(no matches)'
      return { success: true, content: maskGlobOutput(content, credentialConfig) }
    },
  }
}

export const globToolService: Service = {
  inject: ['credentials'],
  apply(ctx) {
    const credentialConfig = ctx.get<CredentialMaskingConfig>('credentials')
    ctx.provide(toolKey('Glob'), withValidation(createGlobTool(credentialConfig)))
  },
}
