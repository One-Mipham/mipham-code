import { readFileSync, existsSync, statSync } from 'node:fs'
import type { ToolDefinition, CredentialMaskingConfig } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'
import type { Service } from '../../vajra'
import { toolKey } from '../seam'
import { withValidation } from '../validation'

export function createReadTool(credentialConfig?: CredentialMaskingConfig): ToolDefinition {
  return {
    name: 'Read',
    description:
      'Read a file from the local filesystem. Supports offset and limit for large files.',
    category: 'file',
    permission: 'auto',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'integer', description: 'Line number to start reading from' },
        limit: { type: 'integer', description: 'Number of lines to read' },
      },
      required: ['file_path'],
    },
    async execute(params, ctx) {
      const filePath = resolveSafe(ctx.cwd, params.file_path as string)
      if (!existsSync(filePath)) {
        return { success: false, content: '', error: `File not found: ${filePath}` }
      }
      const stat = statSync(filePath)
      if (stat.isDirectory()) {
        return { success: false, content: '', error: `Path is a directory: ${filePath}` }
      }
      // Prevent OOM on single-line files (e.g. 500MB JSON blob)
      const MAX_FILE_SIZE = 50_000_000 // 50 MB
      if (stat.size > MAX_FILE_SIZE) {
        return {
          success: false,
          content: '',
          error: `File too large (${(stat.size / 1e6).toFixed(1)} MB). Max: 50 MB. Use offset/limit for large files.`,
        }
      }
      const offset = (params.offset as number) || 0
      const limit = (params.limit as number) || 2000
      const content = readFileSync(filePath, 'utf-8')

      // ── Read tracking: mark file as read for Write tool safety ──
      ctx.readFiles?.add(filePath)

      // ── Credential masking ──
      if (credentialConfig) {
        const { matchCredentialFile, maskContent, CREDENTIAL_SENTINEL } =
          await import('../../core/credential-masker')
        const rule = matchCredentialFile(filePath, credentialConfig)
        if (rule) {
          const masked = maskContent(content, rule)
          // Full-file mask: return sentinel immediately (offset/limit don't apply)
          if (masked === CREDENTIAL_SENTINEL) {
            return { success: true, content: masked }
          }
          // Extract mode: apply offset/limit on masked content
          const maskedLines = masked.split('\n')
          const maskedSlice = maskedLines.slice(offset, offset + limit)
          const maskedResult = maskedSlice
            .map((l, i) => `${String(offset + i + 1).padStart(6, ' ')}\t${l}`)
            .join('\n')
          return { success: true, content: maskedResult }
        }
      }

      const lines = content.split('\n')
      const slice = lines.slice(offset, offset + limit)
      const result = slice
        .map((l, i) => `${String(offset + i + 1).padStart(6, ' ')}\t${l}`)
        .join('\n')
      return { success: true, content: result }
    },
  }
}

export const readToolService: Service = {
  inject: ['credentials'],
  apply(ctx) {
    const credentialConfig = ctx.get<CredentialMaskingConfig>('credentials')
    ctx.provide(toolKey('Read'), withValidation(createReadTool(credentialConfig)))
  },
}
