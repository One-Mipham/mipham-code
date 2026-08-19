/**
 * CRSI Producer — 把累积的失败信号转成「教训文件」代码改动候选。
 *
 * 这是 CRSI 闭环「reflect → verify → consolidate」的 reflect→verify 桥：
 *   - 输入：AutoMemoryEngine 的 CrsiInsight + MetaRuleEngine 的 MetaRule（都是「建议」）。
 *   - 输出：一个 CrsiProposal —— 对 `crsi-lessons.md` 的追加（模板化，不动 LLM 判断）。
 *   - 走 runCrsiModification（沙箱 gate）→ 人类批准 → merge。
 *
 * 诚实标注：沙箱的 verify 是「防回归」（测试仍绿），不是「证明更好」——
 * 后者需要 ground-truth eval harness，是独立的下一步。
 */

import type { CrsiInsight } from './auto-memory'
import type { MetaRule } from './meta-rule-engine'
import type { Llm } from '../providers/llm'
import { readdirSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 教训文件（相对仓库根）。预建，沙箱只能改已存在文件。 */
export const LESSONS_FILE = 'apps/cli/crsi-lessons.md'

/** 归一化的教训信号（insight 与 meta-rule 的公共面）。 */
export interface CrsiSignal {
  category: string
  title: string
  severity?: string
  suggestion: string
  evidence: string[]
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 }

/**
 * 选一条「最该固化成教训」的信号：
 *   1. 优先 autoApplicable 的 insight，按严重度排序（critical > warning > info）。
 *   2. 没有 insight 时，回退到高置信、autoApplicable 的元规则。
 */
export function selectCrsiSignal(
  insights: CrsiInsight[],
  metaRules: MetaRule[],
): CrsiSignal | null {
  const best = insights
    .filter((i) => i.autoApplicable)
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3))[0]
  if (best) {
    return {
      category: best.category,
      title: best.description,
      severity: best.severity,
      suggestion: best.suggestion,
      evidence: best.evidence,
    }
  }

  const mr = metaRules.find((m) => m.autoApplicable && m.confidence === 'high')
  if (mr) {
    return {
      category: mr.category,
      title: mr.title,
      suggestion: mr.recommendation,
      evidence: [mr.evidence.summary],
    }
  }

  return null
}

/** 模板化地把信号渲染成一段教训 markdown（不动 LLM）。 */
export function buildLessonContent(signal: CrsiSignal, timestamp: string): string {
  const lines: string[] = [
    `## ${signal.category}: ${signal.title}`,
    '',
    `- 建议: ${signal.suggestion}`,
  ]
  if (signal.severity) lines.push(`- 严重度: ${signal.severity}`)
  lines.push(`- 生成时间: ${timestamp}`, '- 来源: CRSI producer (autoApplicable)', '', '### 证据')
  for (const e of signal.evidence) lines.push(`- ${e}`)
  lines.push('')
  return lines.join('\n')
}

/** 产出教训文件变更候选。无合格信号时返回 null。 */
export function produceCrsiProposal(
  insights: CrsiInsight[],
  metaRules: MetaRule[],
  currentLessons: string,
  timestamp: string,
): { description: string; filePath: string; newContent: string; originalContent: string } | null {
  const signal = selectCrsiSignal(insights, metaRules)
  if (!signal) return null

  // 幂等：同一信号的教训标题已在文件中，不再重复产出。
  if (currentLessons.includes(`## ${signal.category}: ${signal.title}`)) return null

  const lesson = buildLessonContent(signal, timestamp)
  const newContent = currentLessons ? `${currentLessons.trimEnd()}\n\n${lesson}\n` : `${lesson}\n`

  return {
    description: `CRSI lesson: ${signal.category} — ${signal.title}`,
    filePath: LESSONS_FILE,
    newContent,
    originalContent: currentLessons,
  }
}

// ── Producer 毕业：固化受管理规则（行为，非教训） ──

/** 受管理规则文件（相对仓库根）。 */
export const MANAGED_RULES_FILE = 'apps/cli/src/core/crsi-managed-rules.ts'

/** 追加点标记（与 crsi-managed-rules.ts 内注释一致）。 */
export const MANAGED_RULE_MARKER = '  // ── CRSI producer 追加点（勿删此标记）──'

/** 超时类命令匹配（与 BUILTIN rule-timeout-bash-heavy 一致）。 */
const MANAGED_HEAVY_RE = 'npm (install|ci|test)|docker build|pnpm install|cargo build|brew install'

/** 危险命令匹配（8 行为缺口：rm -rf / 管道投毒 / git reset --hard / chmod 777 / mkfs / dd→/dev/ / 关停主机 / crontab -r）。 */
export const MANAGED_DANGEROUS_RE =
  'rm -rf|git reset --hard|chmod[^\\n]*777|\\|\\s*(bash|sh)\\b|\\bmkfs\\b|dd\\b[^\\n]*of=/dev/|\\b(shutdown|reboot|poweroff|halt)\\b|crontab\\s+-r\\b'

/** 确定性 hash（无 Date.now / Math.random，同信号同 id → 幂等）。 */
function stableHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** 生成受管理规则的稳定 id（同类别 + 同标题 → 同 id）。 */
export function managedRuleId(signal: CrsiSignal): string {
  return `managed-${signal.category}-${stableHash(signal.title)}`
}

/**
 * 把一条信号渲染成 ToolRule 的 TS 对象字面量源（模板化、无 LLM）。
 * 只支持 timeout / tool-params 两类确定性 category，其余返回 null。
 */
export function renderManagedRuleSource(signal: CrsiSignal): string | null {
  const id = managedRuleId(signal)
  const warning = signal.suggestion || `CRSI 自动固化: ${signal.title}`

  if (signal.category === 'timeout') {
    return [
      `  {`,
      `    id: '${id}',`,
      `    toolName: 'Bash',`,
      `    category: 'timeout',`,
      `    match: (p) => { const cmd = String(p.command ?? ''); if (!/${MANAGED_HEAVY_RE}/.test(cmd)) return false; const t = p.timeout; return !t || t < 300000 },`,
      `    fix: (p) => ({ modified: { ...p, timeout: 300000 }, warning: ${JSON.stringify(`⏱️ ${warning}`)} }),`,
      `    source: 'managed',`,
      `    enabled: true,`,
      `  },`,
    ].join('\n')
  }

  if (signal.category === 'tool-params') {
    return [
      `  {`,
      `    id: '${id}',`,
      `    toolName: 'Bash',`,
      `    category: 'tool-params',`,
      `    match: (p) => { const cmd = String(p.command ?? ''); return /${MANAGED_DANGEROUS_RE}/.test(cmd) && !p.dangerouslyDisableSandbox },`,
      `    fix: (p) => ({ modified: p, warning: ${JSON.stringify(`⚠️ ${warning}`)} }),`,
      `    source: 'managed',`,
      `    enabled: true,`,
      `  },`,
    ].join('\n')
  }

  return null
}

/** 产出受管理规则变更候选（毕业路径）。无合格信号 / 同名规则已存在时返回 null。 */
export function produceRuleProposal(
  signal: CrsiSignal,
  currentManagedRules: string,
): { description: string; filePath: string; newContent: string; originalContent: string } | null {
  const ruleSource = renderManagedRuleSource(signal)
  if (!ruleSource) return null

  const id = managedRuleId(signal)
  // 幂等：同名规则已在文件中，不再重复产出。
  if (currentManagedRules.includes(`id: '${id}'`)) return null

  const newContent = currentManagedRules.includes(MANAGED_RULE_MARKER)
    ? currentManagedRules.replace(MANAGED_RULE_MARKER, `${MANAGED_RULE_MARKER}\n${ruleSource}`)
    : `${ruleSource}\n` // 文件缺失/异常时，回退为仅规则块

  return {
    description: `CRSI managed rule: ${signal.category} — ${signal.title}`,
    filePath: MANAGED_RULES_FILE,
    newContent,
    originalContent: currentManagedRules,
  }
}

// ── Producer 散文提议（块 1）：从失败信号生成「改 skill 散文」提议 ──
// A1 边界首次实演：LLM 只作「生成」（候选），判定仍走确定性（guard 预筛 / 行为效果 / 人审）。

const PROSE_SELECT_PROMPT_VERSION = '1.0.0'

function buildSelectSkillPrompt(signal: CrsiSignal, skillFiles: string[]): string {
  return [
    `你是 CRSI producer（producer-prose-select v${PROSE_SELECT_PROMPT_VERSION}）。给定失败信号，从候选 skill 文件列表中选出最相关的一个，返回其文件路径（只返回路径，一行，不要其他文字）。`,
    '',
    '失败信号：',
    `- category: ${signal.category}`,
    `- title: ${signal.title}`,
    signal.severity ? `- severity: ${signal.severity}` : '',
    `- suggestion: ${signal.suggestion}`,
    `- evidence: ${signal.evidence.join(' | ')}`,
    '',
    '候选 skill 文件：',
    ...skillFiles.map((f) => `- ${f}`),
  ]
    .filter(Boolean)
    .join('\n')
}

async function collectLlmText(llm: Llm, prompt: string): Promise<string> {
  let text = ''
  const req = {
    model: 'prose',
    messages: [{ role: 'user' as const, content: prompt }],
    systemPrompt: '',
  }
  for await (const chunk of llm.chat(req)) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content
  }
  return text.trim()
}

function extractFilePath(response: string, skillFiles: string[]): string | null {
  for (const f of skillFiles) {
    if (response.includes(f)) return f
  }
  return null
}

export async function selectTargetSkill(
  signal: CrsiSignal,
  llm: Llm,
  skillFiles: string[],
): Promise<string | null> {
  if (skillFiles.length === 0) return null
  const prompt = buildSelectSkillPrompt(signal, skillFiles)
  const response = await collectLlmText(llm, prompt)
  if (!response) return null
  return extractFilePath(response, skillFiles)
}

const PROSE_GENERATE_PROMPT_VERSION = '1.0.0'

function buildGenerateProsePrompt(
  signal: CrsiSignal,
  filePath: string,
  originalContent: string,
): string {
  return [
    `你是 CRSI producer（producer-prose-generate v${PROSE_GENERATE_PROMPT_VERSION}）。基于失败信号，改进目标 skill 的内容。`,
    '',
    '失败信号：',
    `- category: ${signal.category}`,
    `- title: ${signal.title}`,
    `- suggestion: ${signal.suggestion}`,
    `- evidence: ${signal.evidence.join(' | ')}`,
    '',
    `目标文件：${filePath}`,
    '',
    '当前内容：',
    originalContent,
    '',
    '请返回改进后的完整 markdown（保持 YAML frontmatter 的 name/description 字段，正文针对失败信号做针对性改进）。只返回 markdown，不要额外说明。',
  ].join('\n')
}

function stripMarkdownFence(text: string): string {
  const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
  return match ? match[1]! : text
}

export async function generateProseContent(
  signal: CrsiSignal,
  llm: Llm,
  filePath: string,
  originalContent: string,
): Promise<string | null> {
  const prompt = buildGenerateProsePrompt(signal, filePath, originalContent)
  const response = await collectLlmText(llm, prompt)
  if (!response) return null
  return stripMarkdownFence(response)
}

export interface ProseProposalResult {
  filePath: string
  newContent: string
  originalContent: string
  description: string
}

export async function produceProseProposal(
  signal: CrsiSignal,
  llm: Llm,
  skillFiles: string[],
  readSkill: (filePath: string) => string,
): Promise<ProseProposalResult | null> {
  const filePath = await selectTargetSkill(signal, llm, skillFiles)
  if (!filePath) return null

  let originalContent: string
  try {
    originalContent = readSkill(filePath)
  } catch {
    return null
  }

  const newContent = await generateProseContent(signal, llm, filePath, originalContent)
  if (!newContent) return null

  return { filePath, newContent, originalContent, description: signal.title }
}

const SKILL_DIRS: Array<[string, string]> = [
  ['standard', '.SKILL.md'],
  ['mipham', '.mipham-skill.md'],
]

/** 收集仓库内所有 skill 文件（相对仓库根的路径），供 produceProseProposal 选目标。 */
export function collectSkillFiles(root: string): string[] {
  const files: string[] = []
  for (const [dir, ext] of SKILL_DIRS) {
    let entries: string[] = []
    try {
      entries = readdirSync(join(root, 'apps', 'cli', 'skills', dir))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.endsWith(ext)) files.push(`apps/cli/skills/${dir}/${entry}`)
    }
  }
  return files
}

// ── 幂等去重（prose ledger） ──
// 散文提议（块 1）的幂等：同一失败信号只生成一次提议。与 --rule 路径「目标文件内 id marker」去重不同，
// 散文改的是 skill 内容（非追加 marker），故用 ~/.mipham 下的 append-only ledger 记录「已提议的信号」。

/** 散文提议的稳定 id（同 category + 同 title → 同 id，同 managedRuleId 的 hash 语义）。 */
export function proseProposalId(signal: CrsiSignal): string {
  return `prose-${signal.category}-${stableHash(signal.title)}`
}

/** ledger 里的一条散文提议记录。 */
export interface ProseProposalRecord {
  id: string
  filePath: string
  timestamp: string
}

function proseLedgerFile(): string {
  return join(homedir(), '.mipham', 'crsi', 'prose-proposals.jsonl')
}

/** 该信号是否已生成过散文提议。 */
export function hasProposedProse(id: string): boolean {
  try {
    if (!existsSync(proseLedgerFile())) return false
    const lines = readFileSync(proseLedgerFile(), 'utf-8').trim().split('\n').filter(Boolean)
    return lines.some((line) => {
      try {
        return (JSON.parse(line) as { id?: string }).id === id
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/** 追加一条散文提议记录（append-only，非关键——失败不影响提议本身）。 */
export function appendProseProposal(record: ProseProposalRecord): void {
  try {
    mkdirSync(join(homedir(), '.mipham', 'crsi'), { recursive: true })
    appendFileSync(proseLedgerFile(), JSON.stringify(record) + '\n', 'utf-8')
  } catch {
    // ledger 非关键，失败不影响提议本身
  }
}
