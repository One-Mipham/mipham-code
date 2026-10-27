/**
 * 「这条权限规则写坏了」的告警，每个用户只看一次 —— 直到那条规则本身变了。
 *
 * 规则是从 settings 文件里读的，文件不修，告警就每次启动都会原样重复。重复的
 * 告警不是提醒，是噪音：用户读到第七次时就已经不再读了，于是**新**出现的那条
 * 坏规则混在里面也看不见。认领（ack）按**告警文本**记账，文本变了就是另一条
 * 规则，重新报。
 *
 * 写盘失败一律按「没认领过」处理 —— 宁可多报一次，也不因为盘上写不进去而把
 * 一条本该 fail-closed 的坏规则静默吞掉。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { miphamHome } from './paths'
import { atomicWriteFileSync } from '../shared/atomic-write'

/** 记账文件里保留的条目上限 —— 规则文本会随编辑不断变新，不设上限就是无限长。 */
const MAX_ACKS = 200

interface AckFile {
  acknowledged: string[]
}

function ackPath(): string {
  return miphamHome('permission-rule-acks.json')
}

function readAcks(): string[] {
  const path = ackPath()
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const list = (parsed as AckFile | null)?.acknowledged
    if (!Array.isArray(list)) return []
    return list.filter((v): v is string => typeof v === 'string')
  } catch {
    // 文件坏了 = 没有记账。重报一次然后重写。
    return []
  }
}

/**
 * Narrow `messages` to the ones this user has not seen yet, and remember them.
 *
 * Returns the messages to print. A message that was already acknowledged — and
 * whose text has not changed since — is dropped.
 */
export function unacknowledgedRuleWarnings(messages: readonly string[]): string[] {
  if (messages.length === 0) return []
  const seen = new Set(readAcks())
  const fresh = messages.filter((m) => !seen.has(m))
  if (fresh.length === 0) return []

  for (const m of fresh) seen.add(m)
  const next = [...seen].slice(-MAX_ACKS)
  try {
    const path = ackPath()
    mkdirSync(dirname(path), { recursive: true })
    atomicWriteFileSync(path, `${JSON.stringify({ acknowledged: next }, null, 2)}\n`, {
      mode: 0o644,
    })
  } catch {
    // 写不进去 ⇒ 下次还会报（见文件头：多报比静默好）
  }
  return fresh
}
