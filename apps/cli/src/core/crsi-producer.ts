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
import { readdirSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { appendRegularFileSync } from '../shared/regular-file'
import { miphamHome } from './paths.ts'

/** 教训文件（相对仓库根）。预建，沙箱只能改已存在文件。 */
export const LESSONS_FILE = 'apps/cli/crsi-lessons.md'

/** 组件归因（修复决策，非因果断言）：失败最可能被哪个记忆组件的局部干预修复。 */
export type MemoryComponent = 'experiential' | 'working' | 'invocation' | 'checker'

/** 归一化的教训信号（insight 与 meta-rule 的公共面）。 */
export interface CrsiSignal {
  category: string
  title: string
  severity?: string
  suggestion: string
  evidence: string[]
  /**
   * 组件归因：该失败最可能被哪个记忆组件的局部干预修复。
   * 缺省 experiential（现状 = 教训/技能/受管理规则，全属 E）。
   * working/invocation/checker 待 ②③ 落地后由对应信号源产出。
   */
  component?: MemoryComponent
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
export function buildLessonContent(
  signal: CrsiSignal,
  timestamp: string,
  source = 'CRSI producer (autoApplicable)',
): string {
  const lines: string[] = [
    `## ${signal.category}: ${signal.title}`,
    '',
    `- 建议: ${signal.suggestion}`,
    `- 组件: ${signal.component ?? 'experiential'}`,
  ]
  if (signal.severity) lines.push(`- 严重度: ${signal.severity}`)
  lines.push(`- 生成时间: ${timestamp}`, `- 来源: ${source}`, '', '### 证据')
  for (const e of signal.evidence) lines.push(`- ${e}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * 教训精华（标题 + 建议 + 严重度），用于运行时召回注入系统提示。
 *
 * 严重度决定**注入位置**，不只是标签：`critical` 常驻每一次请求，
 * `warning` 移出常驻块、按需召回（见 {@link isAlwaysOnLesson}），且常驻档整体受
 * {@link RESIDENT_LESSONS_BUDGET} 约束（见 {@link selectResidentLessons}）。
 * 这两个数是**当时的读数、不是不变量**（2026-09-28 实测：39 条全量 11,743 字符，
 * 占 40k 指令预算 29.2%；分档后 6 条常驻）。教训加减后它们就作废，别当断言读。
 */
export interface CrsiLessonSummary {
  title: string
  suggestion: string
  severity: 'critical' | 'warning'
}

/**
 * 缺 `严重度` 或取值在闭集之外时的落档。
 *
 * 取 `critical`（fail-open 到**常驻**）：宁可多花字符，也不把一条守卫
 * 静默降级成「按需」—— 那正是「只写不读」缺口的复发形态。
 * 定义在**一处**：抽取器与 `flush()` 都读它，改一处即改全。
 * 不导出 —— 它没有第二个读者，导出只会让「谁在用」这个问题多一个假答案。
 */
const DEFAULT_LESSON_SEVERITY: CrsiLessonSummary['severity'] = 'critical'

/**
 * 从 crsi-lessons.md 提取每条教训的「精华」（标题 + 建议 + 严重度），跳过证据段落。
 * 这是「只写不读」缺口 → 「写后召回」的读取侧。
 *
 * 按 `##` 块累积、块边界 flush —— 因为 `- 严重度:` 行写在 `- 建议:` **之后**，
 * 「见到建议即 push」的写法读不到它。块级累积对行序不敏感。
 *
 * 缺 `严重度` 时的落档见 {@link DEFAULT_LESSON_SEVERITY}。
 */
export function extractCrsiLessonSummaries(content: string): CrsiLessonSummary[] {
  const out: CrsiLessonSummary[] = []
  let title = ''
  let suggestion = ''
  let severity = DEFAULT_LESSON_SEVERITY

  const flush = () => {
    if (title && suggestion) out.push({ title, suggestion, severity })
    title = ''
    suggestion = ''
    severity = DEFAULT_LESSON_SEVERITY
  }

  for (const line of content.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) {
      flush()
      title = h[1]!.trim()
      continue
    }
    const s = line.match(/^-\s*建议[:：]\s*(.+)$/)
    if (s) {
      if (!suggestion) suggestion = s[1]!.trim() // 块内首条建议为准（与旧行为一致）
      continue
    }
    const v = line.match(/^-\s*严重度[:：]\s*(.+?)\s*$/)
    if (v) {
      // 闭集外的取值一律落常驻档 —— 未知严重度不倒向「按需」。
      severity = v[1] === 'warning' ? 'warning' : 'critical'
    }
  }
  flush()
  return out
}

/**
 * 这条教训是否**有资格**常驻（非 `warning` 的一切，含缺省，都有资格）。
 *
 * 这是**逐条**谓词，只说「档位」，不说「进不进得去」—— 进去还要过预算，
 * 见 {@link selectResidentLessons}。两个问题分开是因为两个问题的答案不同：
 * 全是 critical 时这条谓词全真，而预算仍然会拦下一部分。
 */
export function isAlwaysOnLesson(summary: CrsiLessonSummary): boolean {
  return summary.severity !== 'warning'
}

/**
 * 常驻块的字符预算，按**渲染后**的文本量算。
 *
 * 为什么用字符而不是条数：预算约束的是**每次请求的注入成本**，而单条教训的
 * 长度差三倍以上（2026-09-28 实测 157–570 字符）—— 条数相同，成本可以差一倍。
 *
 * 3,000 ≈ 40k 指令预算的 7.5%（当时 6 条 critical 共 2,155 字符，还有余量）。
 */
export const RESIDENT_LESSONS_BUDGET = 3000

/** {@link selectResidentLessons} 的结果。每个字段各有各的读者，不互相重算。 */
export interface ResidentLessonSelection {
  /** 进常驻块的那些，**文件序** —— 渲染序稳定，不随择优顺序抖动。 */
  resident: CrsiLessonSummary[]
  /** 未常驻的全部（全部 warning + 被预算挤出的 critical），文件序：指针报的是它的条数。 */
  demoted: CrsiLessonSummary[]
  /** `demoted` 里「因预算被挤出」的那部分，文件序：指针点名的是它。 */
  overBudget: CrsiLessonSummary[]
  /**
   * 这次选择**实际用的**预算。
   *
   * 由结果携带而不是让指针去读常量：常量是「默认值」，不一定是「这一次的值」。
   * 指针报一个与实际不符的数，就是又一个「报告描述的不是发出去的那份」。
   */
  budget: number
}

/**
 * 选出真正进常驻块的那些 —— **唯一的择优点**，两个读者都必须走这里。
 *
 * 为什么要有预算：`severity` 是**逐条**的谓词，预算是**整档**的性质。两者错配的
 * 后果是没有东西能说「常驻档太大了」—— 全是 critical 时，每加一条教训就是每次
 * 请求都多付一份钱，且没有上限。
 *
 * 超预算的 critical **不丢弃**：它们落进 `demoted`，由指针点名。无声消失与
 * 「从来没写过这条教训」在外部读数上同形。
 *
 * 择优方向是**文件倒序**（新的优先留下）：文件是追加写的 ⇒ 越靠后越新，而越近的
 * 失败越相关。选中后仍按文件序渲染，避免常驻块的顺序随预算抖动。
 *
 * 单条自身就超预算时它自己出局（在指针里被点名）：预算约束的是**总量**，最长的
 * 单条没有豁免权；截断正文会篡改建议本身，所以不做。
 */
export function selectResidentLessons(
  summaries: CrsiLessonSummary[],
  budget: number = RESIDENT_LESSONS_BUDGET,
): ResidentLessonSelection {
  const criticals = summaries.filter(isAlwaysOnLesson)
  let resident: CrsiLessonSummary[] = []
  const overBudget: CrsiLessonSummary[] = []

  for (let i = criticals.length - 1; i >= 0; i--) {
    const lesson = criticals[i]!
    const candidate = [lesson, ...resident]
    if (buildCrsiLessonsBlock(candidate).length <= budget) {
      resident = candidate
    } else {
      overBudget.unshift(lesson)
    }
  }

  return {
    resident,
    demoted: summaries.filter((s) => !resident.includes(s)),
    overBudget,
    budget,
  }
}

/** 把教训精华渲染为系统提示召回块。无教训时返回空串。 */
export function buildCrsiLessonsBlock(summaries: CrsiLessonSummary[]): string {
  if (summaries.length === 0) return ''
  const items = summaries.map((s, i) => `${i + 1}. **${s.title}**\n   ${s.suggestion}`).join('\n\n')
  return `## CRSI Lessons (Self-Improvement Recall)

These are hard-won lessons consolidated by the CRSI self-improvement
loop from past sessions. Apply them proactively — do not repeat these
mistakes:

${items}`
}

/** 指针最多点名几条被挤出的 critical —— 否则指针自己成了新的无界常驻成本。 */
const POINTER_NAME_LIMIT = 3

/**
 * 未常驻教训的指针行，由 {@link selectResidentLessons} 的结果渲染。全部常驻时返回空串。
 *
 * 指针是**召回触发点**：没有它，移出常驻块就等于把教训变成只写不读。
 * 它不重复正文，只报条数、点名被预算挤出的 critical、给出文件路径 —— 模型用已有的
 * Read/Grep 工具自取（那份文件的路径就是 `lessonsPath`）。
 *
 * 为什么必须把「被预算挤出」与「本来就是 warning」分开说：对读者而言这是两件事 ——
 * 前者是**预算问题**（有杠杆可拉：给别的降档、或把这条缩短），后者是**设计如此**。
 * 混成一句，前者看上去就是后者，问题永远不会有人发现。
 */
export function buildCrsiLessonsPointer(
  selection: ResidentLessonSelection,
  lessonsPath: string,
): string {
  const { demoted, overBudget, budget } = selection
  if (demoted.length === 0) return ''

  const lines = [`另有 ${demoted.length} 条教训未常驻。`]

  if (overBudget.length > 0) {
    const named = overBudget.slice(0, POINTER_NAME_LIMIT).map((s) => s.title)
    const tail = overBudget.length > named.length ? ` 等 ${overBudget.length} 条` : ''
    lines.push(
      `其中 ${overBudget.length} 条 critical 因常驻档预算（${budget} 字符）` +
        `被挤出：${named.join('、')}${tail}。`,
    )
  }

  lines.push(`需要时读 ${lessonsPath}（含标题/建议/证据）。`)
  return lines.join('\n')
}

/**
 * 读教训文件、渲染**常驻**（critical）教训块，供生成算子内联。
 *
 * 与 `InstructionsLoader.crsiLessonsText()` 是**两份投影**，此处刻意**不带指针**：
 * 指针要求读者用 Read/Grep 自取，而生成算子是无工具的 `llm.chat` 单条消息 ——
 * 对它而言指针等于零，只能内联或什么都不给。
 *
 * 择点必须与那份投影**共用** `selectResidentLessons`：两份投影各选各的，
 * 就会出现「主代理看到的常驻集」与「算子看到的常驻集」不是同一个 ——
 * 局部正确、全局遗漏。
 *
 * 文件缺席 ⇒ 空串：算子退回「无教训」的旧形状（纯增量，不改既有行为）。
 */
export function loadAlwaysOnLessonsBlock(lessonsPath: string): string {
  if (!existsSync(lessonsPath)) return ''
  try {
    const summaries = extractCrsiLessonSummaries(readFileSync(lessonsPath, 'utf-8'))
    return buildCrsiLessonsBlock(selectResidentLessons(summaries).resident)
  } catch {
    return ''
  }
}

/** 产出教训文件变更候选。无合格信号时返回 null。 */
export function produceCrsiProposal(
  insights: CrsiInsight[],
  metaRules: MetaRule[],
  currentLessons: string,
  timestamp: string,
): {
  description: string
  filePath: string
  newContent: string
  originalContent: string
  blastRadius: string[]
} | null {
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
    blastRadius: [LESSONS_FILE],
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
  // managed-rule 是「行为固化」，只处理 experiential 组件（timeout/tool-params 本质是 E）。
  // working/invocation/checker 的修复走各自组件路径，不进这里。
  if ((signal.component ?? 'experiential') !== 'experiential') return null
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

/**
 * 只路由不禁用护栏（CRSI 教训 #learning）：拒绝「禁用某内置能力」的 blanket 规则。
 * 命中返回 true——producer 拒绝产出 managed rule，强制改写成「prefer X over Y」路由。
 */
const DISABLE_INTENT_RE =
  /(禁用|禁止|停用|封禁)[^，。\n]{0,20}(工具|能力|功能|tool|capabilit)|\bnever\s+use\b|\bdon'?t\s+use\b|\bdo\s+not\s+use\b/i

/** 检测信号是否表达「禁用某能力」的 blanket 意图（而非「prefer X over Y」路由）。 */
export function hasDisableIntent(signal: CrsiSignal): boolean {
  if (/^(disable|ban|never-use|never_use)$/.test(signal.category)) return true
  return DISABLE_INTENT_RE.test(`${signal.category} ${signal.title} ${signal.suggestion}`)
}

/** 产出受管理规则变更候选（毕业路径）。无合格信号 / 同名规则已存在时返回 null。 */
export function produceRuleProposal(
  signal: CrsiSignal,
  currentManagedRules: string,
): {
  description: string
  filePath: string
  newContent: string
  originalContent: string
  blastRadius: string[]
} | null {
  // 只路由不禁用护栏：拒绝「禁用某内置能力」的 blanket 规则。
  if (hasDisableIntent(signal)) return null
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
    blastRadius: [MANAGED_RULES_FILE],
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

const PROSE_GENERATE_PROMPT_VERSION = '1.2.0'

function buildGenerateProsePrompt(
  signal: CrsiSignal,
  filePath: string,
  originalContent: string,
  lessonsBlock: string,
): string {
  return [
    `你是 CRSI producer（producer-prose-generate v${PROSE_GENERATE_PROMPT_VERSION}）。基于失败信号，改进目标 skill 的内容。`,
    // 常驻教训**内联**（不是指针）：算子是无工具的 `llm.chat` 单条消息，给它指针等于零。
    // 缺席（空串）时不占行 —— 无教训的提示词与从前**逐字相同**（纯增量）。
    ...(lessonsBlock ? ['', lessonsBlock] : []),
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
    '返回格式（严格遵守，两段）：',
    '第 1 行：一行 JSON，写下你对这次改动的**预期效果**与**风险**：',
    '{"expectedDelta": <number 或 null>, "risk": "<字符串>"}',
    '- expectedDelta 是预期该 skill 的任务表现提升**点数**（可正可负；无法预测写 null）。',
    '- risk 是这次改动可能在哪方面变差（一句话）。',
    '第 2 行起：改进后的完整 markdown（保持 YAML frontmatter 的 name/description 字段，正文针对失败信号做针对性改进）。不要用代码围栏包住。',
  ].join('\n')
}

function stripMarkdownFence(text: string): string {
  const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
  return match ? match[1]! : text
}

/** prose 提议的解析产物：正文 + 可选的事前预登记（ε 与风险声明）。 */
export interface ProsePrediction {
  body: string
  /** ε：事前写下的预期提升点数。缺席 = 模型没预测（含显式写 null）。 */
  expectedEffect?: number
  /** R：风险声明。缺席 = 未声明。 */
  risk?: string
}

/**
 * 净变化（未判定）：正文字符数与行数的增减。
 *
 * 这是 `#20 simplicity: 未要求的功能是负债` **唯一可机械化的那一半** —— 判「这份改写
 * 是不是加了没要求的功能」需要语义裁判（违反 A1 铁律），而「它长大了多少」是算得出来的事实。
 * 故与 `formatCostLine` / 风险声明同一纪律：**只呈现、不判定**，标签必须带「未判定」，
 * 否则这一行会被读成「已经审过了」。
 *
 * 注意它不是 diff stat：只报**净额**，不报增删行数。
 * 行数定义 = 换行符数 + （末尾无换行且非空 ? 1 : 0）—— 定义写死，否则这个数不可证伪。
 */
export function formatNetChange(original: string, updated: string): string {
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n))
  const chars = updated.length - original.length
  const lines = countLines(updated) - countLines(original)
  return `📐 净变化（未判定）: 字符 ${signed(chars)}，行 ${signed(lines)}`
}

function countLines(s: string): number {
  if (s === '') return 0
  const breaks = s.split('\n').length - 1
  return s.endsWith('\n') ? breaks : breaks + 1
}

/**
 * 解析 prose 响应：可选的一行 JSON 前缀（ε）+ 正文。
 *
 * 顺序是**先归一化、后嗅探**（不可颠倒）：stripMarkdownFence 的正则锚在串首
 * （/^```(?:markdown|md)?\s*\n…\n```\s*$/）。若先剥「首行围栏」再嗅探，正文尾部的
 * 那个 ``` 就再没有东西去剥它 ⇒ 孤立的尾部围栏会进入写盘路径。
 *
 * 认领标记是**含 `expectedDelta` 键**（盖住 number 与显式 null 两种写法）；
 * 其余任何情况都走兜底 —— 正文 = 归一化后的原文，一字不改。
 */
export function parseProsePrediction(raw: string): ProsePrediction {
  const stripped = stripMarkdownFence(raw)
  const lines = stripped.split('\n')
  const firstIdx = lines.findIndex((l) => l.trim() !== '')
  if (firstIdx === -1) return { body: stripped }

  let parsed: unknown
  try {
    parsed = JSON.parse(lines[firstIdx]!.trim())
  } catch {
    return { body: stripped } // 首行不是 JSON → 兜底
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { body: stripped }
  }
  const rec = parsed as { expectedDelta?: unknown; risk?: unknown }
  if (!('expectedDelta' in rec)) return { body: stripped } // 不带 ε 的 JSON 不吃

  const expectedEffect = typeof rec.expectedDelta === 'number' ? rec.expectedDelta : undefined
  const risk = typeof rec.risk === 'string' ? rec.risk : undefined
  // 剥掉 JSON 行本身 + 紧随其后的空行
  const body = lines
    .slice(firstIdx + 1)
    .join('\n')
    .replace(/^[ \t]*\n/, '')

  return {
    body,
    ...(expectedEffect !== undefined ? { expectedEffect } : {}),
    ...(risk !== undefined ? { risk } : {}),
  }
}

export async function generateProseContent(
  signal: CrsiSignal,
  llm: Llm,
  filePath: string,
  originalContent: string,
  lessonsBlock: string,
): Promise<ProsePrediction | null> {
  const prompt = buildGenerateProsePrompt(signal, filePath, originalContent, lessonsBlock)
  const response = await collectLlmText(llm, prompt)
  if (!response) return null
  return parseProsePrediction(response)
}

export interface ProseProposalResult {
  filePath: string
  newContent: string
  originalContent: string
  description: string
  /** ε：由模型在正文之前写下（见 parseProsePrediction）。 */
  expectedEffect?: number
  /** R：风险声明。 */
  risk?: string
}

export async function produceProseProposal(
  signal: CrsiSignal,
  llm: Llm,
  skillFiles: string[],
  readSkill: (filePath: string) => string,
  /**
   * 常驻教训块（由 `loadAlwaysOnLessonsBlock` 渲染）。**故意必填**：漏传或传 `''`
   * 会让「算子收到教训」这件事静默失效 —— 而它正是本函数存在的意义之一。
   * 必填把「忘了」从静默行为变更变成编译错误。
   */
  lessonsBlock: string,
): Promise<ProseProposalResult | null> {
  const filePath = await selectTargetSkill(signal, llm, skillFiles)
  if (!filePath) return null

  let originalContent: string
  try {
    originalContent = readSkill(filePath)
  } catch {
    return null
  }

  const generated = await generateProseContent(signal, llm, filePath, originalContent, lessonsBlock)
  if (!generated || !generated.body) return null

  return {
    filePath,
    newContent: generated.body,
    originalContent,
    description: signal.title,
    ...(generated.expectedEffect !== undefined ? { expectedEffect: generated.expectedEffect } : {}),
    ...(generated.risk !== undefined ? { risk: generated.risk } : {}),
  }
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
  return miphamHome('crsi', 'prose-proposals.jsonl')
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
    mkdirSync(miphamHome('crsi'), { recursive: true })
    // FIFO 路径上「写不进去」与下面的 catch 同级：ledger 非关键，但**不挂**。
    appendRegularFileSync(proseLedgerFile(), JSON.stringify(record) + '\n')
  } catch {
    // ledger 非关键，失败不影响提议本身
  }
}

/** 清空散文提议 ledger，返回清除的记录数（无文件时返回 0）。 */
export function clearProseProposals(): number {
  try {
    if (!existsSync(proseLedgerFile())) return 0
    const lines = readFileSync(proseLedgerFile(), 'utf-8').trim().split('\n').filter(Boolean)
    rmSync(proseLedgerFile(), { force: true })
    return lines.length
  } catch {
    return 0
  }
}

// ── Producer Crossover（第 4 原子算子）：合并两条重叠教训 ──
// LLM 只生成（选对 + 合并版），判定全走确定性 guard + 沙箱 gate。A1 不破：无 LLM 自评。

const CROSSOVER_PROMPT_VERSION = '1.0.0'

function buildCrossoverPrompt(currentLessons: string): string {
  return [
    `你是 CRSI producer（producer-crossover v${CROSSOVER_PROMPT_VERSION}）。给定当前教训文件，找出两条主题重叠、可合并的教训，生成一条综合教训。`,
    '',
    '当前教训文件：',
    currentLessons,
    '',
    '要求：',
    '1. 找两条「主题重叠」的教训（例如都讲「读码优先」、都讲「隔离」），不要选主题无关的两条。',
    '2. titleA / titleB 是 `## ` 之后、标题的完整文本（含 category 前缀，逐字复制，不要改写；**不含** `## ` 前缀本身）。',
    '3. merged 是合并后的综合教训：category 沿用其中一个、title 概括两者、suggestion 综合两条的核心建议、evidence 综合两条的证据要点。',
    '4. 只返回裸 JSON（不要 markdown 围栏、不要其他文字），格式：',
    '{"titleA":"<完整 ## 行1>","titleB":"<完整 ## 行2>","merged":{"category":"...","title":"...","suggestion":"...","evidence":["...","..."]}}',
  ].join('\n')
}

/** 剥 ```json 围栏（LLM 可能加）。 */
function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/)
  return match ? match[1]! : text
}

/** Crossover 结果：两条教训的完整 ## 行 + 合并版。 */
export interface CrossoverResult {
  titleA: string
  titleB: string
  merged: CrsiSignal
}

/** 解析 crossover 结果；非法 / 字段缺失 → null。 */
export function parseCrossoverResult(text: string): CrossoverResult | null {
  try {
    const obj = JSON.parse(stripJsonFence(text))
    if (typeof obj.titleA !== 'string' || typeof obj.titleB !== 'string') return null
    if (
      !obj.merged ||
      typeof obj.merged.category !== 'string' ||
      typeof obj.merged.title !== 'string' ||
      typeof obj.merged.suggestion !== 'string'
    )
      return null
    const evidence = Array.isArray(obj.merged.evidence)
      ? obj.merged.evidence.filter((e: unknown) => typeof e === 'string')
      : []
    return {
      titleA: obj.titleA,
      titleB: obj.titleB,
      merged: {
        category: obj.merged.category,
        title: obj.merged.title,
        suggestion: obj.merged.suggestion,
        evidence,
      },
    }
  } catch {
    return null
  }
}

/** 从教训文件移除若干 `## ` 段（header 须是 `## ` 行完整文本）。preamble 与其余教训不动。 */
export function removeLessonSections(content: string, headers: string[]): string {
  const lines = content.split('\n')
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (line.startsWith('## ')) {
      skipping = headers.includes(line.trim())
      if (skipping) continue
    }
    if (skipping) continue
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Crossover：合并两条重叠教训 → 「删二增一」的教训文件变更候选。
 * LLM 只生成（选对 + 合并版），guard 校验所选教训真实存在（fail-closed 防幻觉）。
 */
export async function produceCrossoverProposal(
  llm: Llm,
  currentLessons: string,
  timestamp: string,
): Promise<{
  description: string
  filePath: string
  newContent: string
  originalContent: string
  blastRadius: string[]
  merge: boolean
} | null> {
  const response = await collectLlmText(llm, buildCrossoverPrompt(currentLessons))
  if (!response) return null

  const parsed = parseCrossoverResult(response)
  if (!parsed) return null

  const headerA = `## ${parsed.titleA}`
  const headerB = `## ${parsed.titleB}`
  if (parsed.titleA === parsed.titleB) return null
  // 精确行匹配（与 removeLessonSections 同语义）：子串 includes 会让「截断标题」漏过 guard、
  // 却因 removeLessonSections 精确匹配删不掉 → 假「删二增一」实为「增一」。fail-closed 用精确匹配。
  const lessonLines = currentLessons.split('\n').map((l) => l.trim())
  if (!lessonLines.includes(headerA) || !lessonLines.includes(headerB)) return null

  const withoutTwo = removeLessonSections(currentLessons, [headerA, headerB])
  const mergedSection = buildLessonContent(parsed.merged, timestamp, 'CRSI producer (crossover)')
  const newContent = `${withoutTwo.trimEnd()}\n\n${mergedSection}\n`

  return {
    description: `CRSI crossover: ${parsed.titleA} + ${parsed.titleB}`,
    filePath: LESSONS_FILE,
    newContent,
    originalContent: currentLessons,
    blastRadius: [LESSONS_FILE],
    merge: true,
  }
}
