import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFileSync } from '../shared/atomic-write'

// Skill 使用记录：name → 最近调用时间戳（epoch ms）。持久化到 ~/.mipham/skill-usage.json，
// 供 /skill-doctor 识别「从未被调用」的 skill（跨会话累积，按证据 prune）。
const USAGE_DIR = join(homedir(), '.mipham')
const USAGE_FILE = join(USAGE_DIR, 'skill-usage.json')

/** 读 skill 使用记录。文件缺失或损坏（非法 JSON / 类型不符）→ 空 Map，绝不抛错。 */
export function loadSkillUsage(): Map<string, number> {
  try {
    const raw = readFileSync(USAGE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const map = new Map<string, number>()
    for (const [name, ts] of Object.entries(parsed)) {
      if (typeof ts === 'number') map.set(name, ts)
    }
    return map
  } catch {
    return new Map()
  }
}

/** 记录一次 skill 调用。原子写（temp + rename），读者要么见旧值要么见新值，绝不读到半截。 */
export function recordSkillUsage(name: string, now = Date.now()): void {
  const map = loadSkillUsage()
  map.set(name, now)
  const obj: Record<string, number> = {}
  for (const [k, v] of map) obj[k] = v
  mkdirSync(USAGE_DIR, { recursive: true })
  atomicWriteFileSync(USAGE_FILE, JSON.stringify(obj))
}
