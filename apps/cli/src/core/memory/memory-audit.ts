import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { extractWikilinks, readMemoryFile } from './memory-manager'

/**
 * 记忆库体检：找出「盘上有、系统看不见」的分歧。
 *
 * 四类问题都是同一物种 —— 存储与加载各说各话，而运行时**静默**吞掉差异：
 *
 * - `invisible`：文件读不出记忆条目（无 frontmatter / 无 name / 读不了），
 *   会永远躺在 `~/.mipham/memory/` 里却召不回来。
 * - `duplicate-name`：两个文件声明同一个 `name`，Map 按 name 存 ⇒ 后读的
 *   覆盖先读的，另一个文件从此不可达。
 * - `broken-link`：`[[x]]` 指向不存在的记忆，链接图里那条边是死边。
 * - `index-drift`：`MEMORY.md` 与真实条目对不上（只在写入时重建，手改文件
 *   就会漂移）—— 漂移的是给人看的那份，人读到的清单会说谎。
 *
 * 只读：不移动、不改写、不归档。`/memory gc` 才是会动手的那个。
 */

export type MemoryIssueKind = 'invisible' | 'duplicate-name' | 'broken-link' | 'index-drift'

export interface MemoryIssue {
  kind: MemoryIssueKind
  /** 文件名、记忆名或链接目标，视 kind 而定 */
  subject: string
  detail: string
}

const INDEX_FILE = 'MEMORY.md'

const PROBLEM_TEXT: Record<string, string> = {
  'no-frontmatter': 'no frontmatter — the loader skips it',
  'no-name': 'frontmatter has no name — the loader skips it',
  unreadable: 'unreadable',
}

export function auditMemoryDir(dir: string): MemoryIssue[] {
  const issues: MemoryIssue[] = []
  if (!existsSync(dir)) return issues

  let files: string[]
  try {
    files = readdirSync(dir)
      .filter((f) => extname(f) === '.md' && f !== INDEX_FILE)
      .sort()
  } catch {
    return issues
  }

  const byName = new Map<string, string[]>()
  const linkSources = new Map<string, string[]>()

  for (const file of files) {
    const { entry, problem } = readMemoryFile(join(dir, file))
    if (!entry) {
      issues.push({
        kind: 'invisible',
        subject: file,
        detail: PROBLEM_TEXT[problem ?? 'unreadable']!,
      })
      continue
    }
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), file])
    // 用加载器自己的取链接规则（含 10 条硬上限），否则医生会报出系统根本不认的边。
    for (const target of extractWikilinks(entry.content)) {
      linkSources.set(target, [...(linkSources.get(target) ?? []), file])
    }
  }

  for (const [name, owners] of byName) {
    if (owners.length > 1) {
      issues.push({ kind: 'duplicate-name', subject: name, detail: owners.join(', ') })
    }
  }

  for (const [target, sources] of linkSources) {
    if (!byName.has(target)) {
      issues.push({ kind: 'broken-link', subject: target, detail: sources.join(', ') })
    }
  }

  let indexRaw: string | null = null
  try {
    indexRaw = readFileSync(join(dir, INDEX_FILE), 'utf-8')
  } catch {
    indexRaw = null
  }
  const listed = new Set<string>()
  if (indexRaw) {
    for (const match of indexRaw.matchAll(/^- \[([^\]]+)\]\(/gm)) listed.add(match[1]!)
  }
  for (const name of byName.keys()) {
    if (!listed.has(name)) {
      issues.push({ kind: 'index-drift', subject: name, detail: 'missing from MEMORY.md' })
    }
  }
  for (const name of listed) {
    if (!byName.has(name)) {
      issues.push({ kind: 'index-drift', subject: name, detail: 'stale — no such memory' })
    }
  }

  return issues
}
