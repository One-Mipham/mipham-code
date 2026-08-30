/**
 * PostFlightChecker — 事后检查器（Recuris C 组件）。
 *
 * Recuris M=(E,W,ρ,C) 的 C：检查器。核心原则「调用技能/尝试工具 ≠ 完成证据；
 * 只有工具/env 的观察结果支撑才算」。`PreFlightChecker` 是事前拦截（ErrorSignatureDB
 * + RuleEngine），本模块是事后验证：把「完成谓词 (observation) => boolean」抽象出来，
 * 对工具结果核对，决策写进会话轨迹（供 ① 组件归因 + eval 打分）。
 *
 * 设计约束：
 *   - 默认 no-checker 静默、rejected 只记录不阻塞（第一阶段只产证据，不强制拦截）。
 *   - 确定性、无 LLM、可单测。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { ToolResult } from '../shared/types'

/** 工具事后观察：工具实际用的参数 + 工具返回结果。 */
export interface ToolObservation {
  params: Record<string, unknown>
  result: ToolResult
}

export type CheckerDecision =
  | { verdict: 'supported'; checkerId: string }
  | { verdict: 'rejected'; checkerId: string; reason: string }
  | { verdict: 'no-checker' }

/** 完成谓词：工具/env 观察是否支撑「该变更已生效」。绝不信任模型自称成功。 */
export type Checker = (observation: ToolObservation) => boolean

export class PostFlightChecker {
  private checkers = new Map<string, { id: string; predicate: Checker }>()

  register(checkerId: string, toolName: string, predicate: Checker): void {
    this.checkers.set(toolName, { id: checkerId, predicate })
  }

  /** 事后核对一次工具结果。无匹配 checker 时返回 no-checker（不阻塞）。 */
  check(toolName: string, observation: ToolObservation): CheckerDecision {
    const entry = this.checkers.get(toolName)
    if (!entry) return { verdict: 'no-checker' }
    try {
      return entry.predicate(observation)
        ? { verdict: 'supported', checkerId: entry.id }
        : {
            verdict: 'rejected',
            checkerId: entry.id,
            reason: `post-condition failed (${entry.id})`,
          }
    } catch {
      return { verdict: 'rejected', checkerId: entry.id, reason: `checker threw (${entry.id})` }
    }
  }
}

// ── 首批 checker（最小、确定性、可测） ──

/** Bash → exit code 0（对齐 detectViolations 语义，不重复实现）。 */
function bashExit(o: ToolObservation): boolean {
  return o.result.success === true
}

/** Write → 文件存在且长度一致。 */
function writeExists(o: ToolObservation): boolean {
  if (!o.result.success) return false
  const filePath = String(o.params.file_path ?? '')
  if (!filePath) return false
  try {
    if (!existsSync(filePath)) return false
    const expected = Buffer.byteLength(String(o.params.content ?? ''), 'utf-8')
    return statSync(filePath).size === expected
  } catch {
    return false
  }
}

/** Edit → 工具返回 applied 且 new_string 已生效（退化为「old_string 无残留」）。 */
function editApplied(o: ToolObservation): boolean {
  if (!o.result.success) return false
  const filePath = String(o.params.file_path ?? '')
  const newString = String(o.params.new_string ?? '')
  const oldString = String(o.params.old_string ?? '')
  if (!filePath) return false
  try {
    if (!existsSync(filePath)) return false
    const text = readFileSync(filePath, 'utf-8')
    if (newString) return text.includes(newString)
    if (oldString) return !text.includes(oldString)
    return true
  } catch {
    return false
  }
}

/** 默认 checker：Bash/Write/Edit 三件套（工具作用域后置条件）。 */
export function createDefaultPostFlightChecker(): PostFlightChecker {
  const c = new PostFlightChecker()
  c.register('bash-exit', 'Bash', bashExit)
  c.register('write-exists', 'Write', writeExists)
  c.register('edit-applied', 'Edit', editApplied)
  return c
}
