// apps/cli/src/core/proposal-guard.ts
// CRSI 提案预筛器（块 2 最小版）：结构确定性预筛，零 LLM。
//
// 这是 CRSI 自改进「producer 改散文」闭环的第一道闸（三层验证的第①层）：
//   ① 结构确定性（本文件）：受保护路径 + 自引用封闭 + 目标范围 + 结构不变量
//   ② 行为效果（M3/A：LLM 生成行为 → 测试判定）—— 留作 seam，未实现
//   ③ 人类审批 —— CrsiSandbox 之后
//
// 诚实边界：本预筛只能证「结构合法」，不能证「散文更好」——
// 后者是第②层（行为效果）的职责，需要 LLM 生成行为，属另一 A1 边界决策。

import { parse as parseYaml } from 'yaml'
import { isProtectedPath } from './crsi-sandbox'
import { MANAGED_RULES_FILE, MANAGED_RULE_MARKER } from './crsi-producer'

/** producer 产出的一条「改散文」提议（最小字段集，guard 阶段只消费这些）。 */
export interface ProducerProposal {
  id: string
  /** 仓库根相对路径 */
  filePath: string
  /** 最小版只放行两类目标，收窄散文风险面 */
  kind: 'skill' | 'managed-rule'
  /** 改后的完整文件内容 */
  newContent: string
}

export interface PrefilterVerdict {
  pass: boolean
  /** 拒绝理由；pass=true 时为空 */
  reasons: string[]
}

const SKILL_DIR = 'apps/cli/skills/'

function isSkillPath(filePath: string): boolean {
  return (
    filePath.startsWith(SKILL_DIR) &&
    (filePath.endsWith('.SKILL.md') || filePath.endsWith('.mipham-skill.md'))
  )
}

/**
 * 更严、独立于 skills loader 的最小 frontmatter 解析。
 *
 * 与 loader 的宽松回退不同：frontmatter 缺失 / YAML 非法 / name 或 description
 * 为空，都判失败（返回 null）——proposal 必须显式携带合法头部，不得依赖
 * loader 的「文件名兜底 name」「空 description」等宽进逻辑。
 */
function parseStrictSkillFrontmatter(raw: string): { name: string; description: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) return null

  let data: unknown
  try {
    data = parseYaml(match[1] || '')
  } catch {
    return null
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const obj = data as Record<string, unknown>

  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  const description = typeof obj.description === 'string' ? obj.description.trim() : ''
  if (!name || !description) return null
  return { name, description }
}

export function prefilterProposal(p: ProducerProposal): PrefilterVerdict {
  const reasons: string[] = []

  // ① 受保护路径 + 自引用封闭（isProtectedPath 已含评估机制自身的 5 个补洞）
  if (isProtectedPath(p.filePath)) {
    reasons.push(`protected path: ${p.filePath} is read-only to the self-improvement loop`)
  }

  // ② 目标范围白名单
  const inScope =
    (p.kind === 'skill' && isSkillPath(p.filePath)) ||
    (p.kind === 'managed-rule' && p.filePath === MANAGED_RULES_FILE)
  if (!inScope) {
    reasons.push(`out of scope: ${p.filePath} is not an allowed ${p.kind} target`)
  }

  // ③ 结构不变量
  if (p.kind === 'skill') {
    if (!parseStrictSkillFrontmatter(p.newContent)) {
      reasons.push(
        'skill frontmatter invalid: missing/illegal frontmatter or empty name/description',
      )
    }
  } else if (!p.newContent.includes(MANAGED_RULE_MARKER)) {
    reasons.push('managed rule missing the producer append marker')
  }

  // ②（行为效果 seam）：此处接入 M3/A 任务表现度量——用 LLM 生成行为 + 确定性
  // 测试判定，过滤「行为效果退化」的提议。未实现，属 producer LLM 生成能力（块 1）。

  return { pass: reasons.length === 0, reasons }
}
