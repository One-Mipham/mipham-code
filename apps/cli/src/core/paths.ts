/**
 * 项目内数据目录的路径单一真源。
 *
 * 写入一律落在 `.mipham/`（我们自己的目录）；`.claude/` 只保留**只读兼容** ——
 * 早期版本把 worktree 建在 `.claude/worktrees/` 下，那些工作树今天仍要可列举、
 * 可退出、可隔离。因此隔离判据必须同时认两个前缀：只认新前缀会让旧工作树
 * 突然失去隔离保护（隔离度只许增不许减）。
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
 * 规范化 worktree 路径，两侧都过一遍才谈得上比较。
 *
 * 叶子不存在是常态（工作树已被删、或路径是模型编出来的），此时 `realpathSync`
 * 会抛 —— 那就只规范父目录、最后一段按原样留着，否则「叶子没了」会被误读成
 * 「拼法不同」（明明同一个路径，却因为 P 的拼法与 git 打印的不同而判成不在）。
 */
function canonicalWorktreePath(path: string): string {
  const trimmed = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path
  try {
    return realpathSync(trimmed)
  } catch {
    try {
      return join(realpathSync(dirname(trimmed)), basename(trimmed))
    } catch {
      return trimmed
    }
  }
}

/**
 * `git worktree list --porcelain` 里是否**确实**列出了 `target` 这个工作树。
 *
 * 不能用 `output.includes(target)`：那是子串判定，本机实测（真 git，建出 `w1`
 * 与 `w10`）它错在三个方向 ——
 *   - `.../w1` 命中 **`.../w10` 那一行**（前缀当成同一个）⇒ 不存在被判成存在。
 *     EnterWorktree 那侧因此连 `w1` 都建不出来：明明没有，它报 already exists；
 *   - 带尾斜杠的 `.../w1/` 一行都不命中 ⇒ 存在被判成 not found；
 *   - git 打印 **realpath 拼法**（`mktemp -d /tmp/x` 建的在 porcelain 里是
 *     `/private/tmp/x/...`）⇒ 别名拼法一头都命中不了，而 EnterWorktree 的成功
 *     文案里印的正是它自己算出来的那个拼法，模型照抄回来必然吃 not found。
 *
 * 判据是**相等**（名字比对），不是包含 —— 工作树列表里列的就是工作树根。
 */
export function listsWorktree(output: string, target: string): boolean {
  const want = canonicalWorktreePath(target)
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => canonicalWorktreePath(line.slice('worktree '.length).trim()) === want)
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

/**
 * 新建 workflow 脚本的目录（绝对路径）。与 worktree 同理：写入落在 `.mipham/`。
 *
 * 注意别与**运行产物**目录混淆：`~/.mipham/workflows/<runId>/`（见
 * `workflow/journal.ts`）同名但不同义，装的是 journal 与转录。两者靠「非递归
 * readdir + 只收 .js」区分，属巧合而非设计，故本函数绝不返回那个根。
 */
export function workflowScriptDir(cwd: string): string {
  return join(cwd, MIPHAM_DIR, 'workflows')
}

/**
 * 全部可读的 workflow 脚本目录，写入根在前。
 *
 * 读侧必须同时认新旧前缀，否则升级后第一次 `/workflow save` 会失败 ——
 * 上一次运行的 `.last-run.json` 还在旧目录里。用户级旧前缀也保留在列，
 * 但**没有**对应的 `~/.mipham/workflows` 用户级脚本根：那里是运行产物的地盘。
 */
export function workflowScriptDirs(cwd: string): string[] {
  return [
    workflowScriptDir(cwd),
    join(cwd, LEGACY_CLAUDE_DIR, 'workflows'),
    join(homedir(), LEGACY_CLAUDE_DIR, 'workflows'),
  ]
}
