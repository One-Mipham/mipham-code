/**
 * 项目内数据目录的路径单一真源。
 *
 * 写入一律落在 `.mipham/`（我们自己的目录）；`.claude/` 只保留**只读兼容** ——
 * 早期版本把 worktree 建在 `.claude/worktrees/` 下，那些工作树今天仍要可列举、
 * 可退出、可隔离。因此隔离判据必须同时认两个前缀：只认新前缀会让旧工作树
 * 突然失去隔离保护（隔离度只许增不许减）。
 */

import { join } from 'node:path'
import { MIPHAM_DIR } from '../shared/constants.ts'

/** 只读兼容目录名。 */
export const LEGACY_CLAUDE_DIR = '.claude'

/**
 * worktree 的识别标记（含结尾斜杠），新前缀在前。
 * 用于从 `cwd` 反推 worktree 所属的项目根。
 */
export const WORKTREE_MARKERS = [
  `${MIPHAM_DIR}/worktrees/`,
  `${LEGACY_CLAUDE_DIR}/worktrees/`,
] as const

/** 新建 worktree 的根目录（绝对路径）。 */
export function worktreeRoot(cwd: string): string {
  return join(cwd, MIPHAM_DIR, 'worktrees')
}

/** 历史与当前的全部 worktree 根目录，写入根在前。 */
export function worktreeRoots(cwd: string): string[] {
  return [worktreeRoot(cwd), join(cwd, LEGACY_CLAUDE_DIR, 'worktrees')]
}

/**
 * 在 `cwd` 中定位 worktree 标记，返回项目根与命中的标记。
 * 不在任何 worktree 内时返回 null。
 */
/**
 * Locate the project root by looking for a worktree marker in `cwd`.
 *
 * The returned `root` has no trailing separator: callers compose it as
 * `root + '/'` for a prefix compare, and a trailing slash there would make
 * the pattern `${root}//` match nothing.
 */
export function findWorktreeMarker(cwd: string): { root: string; marker: string } | null {
  for (const marker of WORKTREE_MARKERS) {
    const index = cwd.indexOf(marker)
    if (index !== -1) return { root: cwd.substring(0, index).replace(/\/+$/, ''), marker }
  }
  return null
}
