import { Glob } from 'bun'
import { spawnSync } from 'node:child_process'
import type { ToolDefinition, CredentialMaskingConfig } from '../../shared/index.ts'
import { resolveSafe } from '../../security/path'
import type { Service } from '../../vajra'
import { toolKey } from '../seam'
import { withValidation } from '../validation'
import { maskGlobOutput } from '../../core/credential-masker'

/** 结果上限：超过则显式截断并附标记（不能静默丢内容——模型会误以为看全了，
 *  与 Grep 的 `truncateGrepOutput` 同一约定）。 */
const GLOB_MAX_RESULTS = 500

/** 每批向 `git check-ignore` 询问的路径数（一次进程，摊薄启动成本）。 */
const GLOB_IGNORE_BATCH = 500

/**
 * Drop the paths git would ignore.
 *
 * `Bun.Glob` knows nothing about `.gitignore`, so `Glob **\/*` in a repository
 * returned `node_modules/…` and build output alongside real sources. This asks
 * git itself (`check-ignore --stdin -z`, paths echoed verbatim), so the answer
 * is the repository's own rule set — nested `.gitignore` files, negations,
 * core.excludesFile and all.
 *
 * Fail-open by design: outside a work tree, when git is missing, or when the
 * call errors (status 1 = "nothing ignored", 128 = fatal), every path is kept.
 * Filtering is a convenience; silently returning *nothing* because git could
 * not answer would be indistinguishable from "no matches".
 */
/**
 * Jujutsu (`.jj`) and Sapling (`.sl`) keep repository metadata in those
 * directories — the equivalent of `.git`. ripgrep and `Bun.Glob` only know the
 * older VCS names, so without this a search descends into a second copy of the
 * worktree (CC 2.1.86-002).
 */
export function isVcsMetadataPath(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === '.jj' || segment === '.sl')
}

export function filterGitIgnored(paths: string[], cwd: string): string[] {
  if (paths.length === 0) return paths
  const ignored = new Set<string>()
  for (let i = 0; i < paths.length; i += GLOB_IGNORE_BATCH) {
    const batch = paths.slice(i, i + GLOB_IGNORE_BATCH)
    const res = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd,
      input: batch.join('\0') + '\0',
      maxBuffer: 16 * 1024 * 1024,
    })
    // status 0 = at least one ignored; 1 = none; null/128 = not a repo or no git.
    if (res.status !== 0 || !res.stdout) continue
    for (const p of res.stdout.toString().split('\0')) if (p) ignored.add(p)
  }
  return paths.filter((p) => !ignored.has(p))
}

export function createGlobTool(credentialConfig?: CredentialMaskingConfig): ToolDefinition {
  return {
    name: 'Glob',
    description:
      'Find files matching a glob pattern. Inside a git repository, files ignored by .gitignore are excluded.',
    category: 'file',
    permission: 'self',
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
      let pending: string[] = []
      // 过滤放在**取满 500 之前**：先收 500 个再过滤，忽略项多的树会只剩几十条
      // 却仍报「截断到 500」；反过来先过滤再数，截断标记描述的才是真实结果集。
      const keep = (batch: string[]) => {
        if (batch.length === 0) return
        const visible = batch.filter((p) => !isVcsMetadataPath(p))
        for (const p of filterGitIgnored(visible, basePath)) results.push(p)
      }
      for await (const file of glob.scan({ cwd: basePath, absolute: true })) {
        pending.push(file)
        if (pending.length >= GLOB_IGNORE_BATCH) {
          keep(pending)
          pending = []
          if (results.length > GLOB_MAX_RESULTS) {
            // 只有真的还有第 501 个**未被忽略**的匹配时才叫截断 —— 恰好 500 个是完整结果。
            truncated = true
            break
          }
        }
      }
      if (!truncated) {
        keep(pending)
        truncated = results.length > GLOB_MAX_RESULTS
      }
      results.length = Math.min(results.length, GLOB_MAX_RESULTS)
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
