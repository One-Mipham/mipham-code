import { Glob } from 'bun'
import type { ToolDefinition, CredentialMaskingConfig } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'
import type { Service } from '../../vajra'
import { toolKey } from '../seam'
import { withValidation } from '../validation'
import { maskGlobOutput } from '../../core/credential-masker'

/** 结果上限：超过则显式截断并附标记（不能静默丢内容——模型会误以为看全了，
 *  与 Grep 的 `truncateGrepOutput` 同一约定）。 */
const GLOB_MAX_RESULTS = 500

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
      let truncated = false
      for await (const file of glob.scan({ cwd: basePath, absolute: true })) {
        if (results.length >= GLOB_MAX_RESULTS) {
          // 只有真的还有第 501 个匹配时才叫截断 —— 恰好 500 个匹配是完整结果。
          truncated = true
          break
        }
        results.push(file)
      }
      // 先掩码正文、再拼注解：`maskGlobOutput` 是**逐行当路径**去比对的
      // （每行都过 `matchCredentialFile`），注解不是路径，不该喂给它。
      const content = maskGlobOutput(results.join('\n') || '(no matches)', credentialConfig)
      return {
        success: true,
        content: truncated
          ? `${content}\n\n... (truncated at ${GLOB_MAX_RESULTS} matches — narrow the pattern or "path")`
          : content,
      }
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
