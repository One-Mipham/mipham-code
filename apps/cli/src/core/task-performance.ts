// apps/cli/src/core/task-performance.ts
// CRSI 任务表现评估器：LLM 生成代码 + 冻结测试判定，输出随改动变化的分数。
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tasksFile from './task-performance-tasks.json' with { type: 'json' }
import type { Llm } from '../providers/llm'
import { parseFrontmatter } from '../skills/loader'

export type PerformanceTaskCategory = 'test-driven' | 'bug-fix'

/**
 * 任务分池。`gate` = 参与候选选择与改进判定；`sealed` = **只在读数值时出现**，
 * 永不进入任何裁定（见设计文档 §4.3）。
 */
export type TaskPool = 'gate' | 'sealed'

export interface PerformanceTask {
  id: string
  category: PerformanceTaskCategory
  prompt: string
  testCode: string
  skill?: string // 绑定被测 skill 的名字（= skill frontmatter name）
  /**
   * 手写参考解。**必须**能通过本任务自己的 `testCode` —— 由
   * `test/integrity/task-battery.test.ts` 逐题机械验证。
   *
   * 它是捕获率的上界（分母 `100 − off`）：参考解若不满分，说明是题或答案坏了，
   * 而不是被测 skill 不好。
   */
  oracleCode: string
  /** 分池，缺省 `'gate'`。 */
  split?: TaskPool
}

/**
 * 取任务集。**缺省 `'gate'`** —— 所有选择/改进路径因此天然看不到 sealed，
 * 不需要逐处修改调用点；`'all'` 只给守卫与测试用。
 */
export function loadPerformanceTasks(opts?: { pool?: TaskPool | 'all' }): PerformanceTask[] {
  const all = tasksFile.tasks as PerformanceTask[]
  const pool = opts?.pool ?? 'gate'
  if (pool === 'all') return all
  return all.filter((t) => (t.split ?? 'gate') === pool)
}

export interface JudgeResult {
  passed: boolean
  detail?: string
}

const DEFAULT_TIMEOUT_MS = 5000

/** 把生成代码 + 冻结测试写入临时目录，子进程跑 `bun test`，exit 0 即 pass。 */
export function judgeGeneratedCode(
  testCode: string,
  solutionCode: string,
  opts?: { timeoutMs?: number },
): JudgeResult {
  const dir = mkdtempSync(join(tmpdir(), 'mipham-task-perf-'))
  try {
    writeFileSync(join(dir, 'solution.ts'), solutionCode)
    writeFileSync(join(dir, 'solution.test.ts'), testCode)
    try {
      execSync('bun test solution.test.ts', {
        cwd: dir,
        timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        stdio: 'pipe',
      })
      return { passed: true }
    } catch (e) {
      const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? ''
      return { passed: false, detail: stderr.slice(0, 300) }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface TaskPerformanceResult {
  id: string
  description: string
  passed: boolean
  detail?: string
  /**
   * The generation hit the output cap, so the code is incomplete by construction and
   * a failing test cannot distinguish "did not solve it" from "was cut off". Kept on
   * the result and excluded from `score` — mixing the two biases the readout low.
   */
  truncated?: boolean
  /**
   * 没测到，而不是没答对：零文本且 provider 连 usage 都没报。
   *
   * 与 `truncated` 同族但**不同名** —— 前者是「仪器/上游故障」，后者是「输出被截断」。
   * 两者都不进 `score`，但必须分开计数：合成一个数字会让「上游挂了」与「上限太短」
   * 在读数上同形（见 docs/superpowers/specs/2026-11-20-crsi-eval-governance-design.md §4.6）。
   */
  uncertain?: boolean
}

/** 空模型闸的读数：`passed` = 空程序也能通过的题数。 */
export interface NullModelCheck {
  total: number
  passed: number
  /** 空程序也通过的题 id —— 它们正是这道闸抓到的「不是模型题」的题。 */
  failures: string[]
}

/**
 * 空模型消融：对每道题只用**空程序**跑冻结测试。
 *
 * 来源是自改进研究的 null-model control：把模型换成空 stub 重跑，分数仍涨就说明
 * 「改进」不是模型带来的。在我们的架构里模型不产出 ⇒ 空程序；能通过，就说明这道
 * 题测的是测试自身的空转（例如恒真断言），不是模型能力。
 */
export function countEmptySolutionPasses(tasks: PerformanceTask[]): NullModelCheck {
  const failures: string[] = []
  for (const task of tasks) {
    if (judgeGeneratedCode(task.testCode, '').passed) failures.push(task.id)
  }
  return { total: tasks.length, passed: failures.length, failures }
}

/** 按 skill 名取任务集再跑空模型闸；未绑定任何任务的 skill → total 0（空转，不是通过）。 */
export function runNullModelCheck(skill?: string): NullModelCheck {
  const tasks = loadPerformanceTasks().filter((t) => (t.skill ?? undefined) === skill)
  return countEmptySolutionPasses(tasks)
}

export interface TaskPerformanceReport {
  total: number
  passed: number
  /**
   * Percent of **non-truncated** tasks that passed (100 when there are none). A
   * truncated task is reported in `total`/`truncated` but never scored.
   */
  score: number
  results: TaskPerformanceResult[]
  failures: string[]
  /** Tasks whose generation was cut off at the output cap; counted, not scored. */
  truncated: number
  /** 仪器/上游故障（零文本且零 usage）；只计数，不进分数。 */
  uncertain: number
  /**
   * 这一轮**到底测到没有**：至少有一道题进了分母。
   *
   * `false` 时 `score` 的 100 是「无题可评分」的占位，**不是满分**。任何把它当分数
   * 用的地方（展示、改进判定、奖励闸）都必须先看这个字段 —— 否则一次 provider
   * 抽风会读成「满分」，进而产出假的 improved / 假的 regressed。
   */
  measurable: boolean
  /** B2 代价维：整轮（LLM 生成 + 冻结测试判定）的墙钟耗时。只记录，不参与任何判定。 */
  durationMs: number
  /**
   * RSI Tax：本轮测量烧掉的 token（provider 报的 usage 之和）。
   * 缺席 = provider 一次 usage 都没报（与「报了 0」区分）—— 缺席按「未测」处理，
   * 不得当成免费。只记录，不参与任何判定。
   */
  tokensUsed?: number
}

/** 剥掉 LLM 可能包裹的 markdown 代码块（```ts ... ```），拿到裸代码。 */
export function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:ts|typescript|js|javascript)?\n([\s\S]*?)```/)
  return (fenced?.[1] ?? text).trim()
}

async function collectGeneratedCode(
  llm: Llm,
  prompt: string,
  systemPrompt?: string,
): Promise<{ code: string; truncated: boolean; tokens: number; usageReported: boolean }> {
  let text = ''
  let truncated = false
  let tokens = 0
  let usageReported = false
  const req = {
    model: '', // falsy → registry 回退到 active model
    messages: [{ role: 'user' as const, content: prompt }],
    temperature: 0, // 温度 0，近确定
    ...(systemPrompt ? { systemPrompt } : {}),
  }
  for await (const chunk of llm.chat(req)) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content
    // 验证成本（RSI Tax）：provider 在流中报的 usage 就是这次测量烧掉的 token。
    // `usageReported` 与数值分开：报 0 和「没报」不是同一件事，0 会被读成免费。
    if (chunk.type === 'usage') {
      usageReported = true
      // All four billed buckets — cache reads are usually the bulk of the prompt.
      tokens +=
        (chunk.inputTokens ?? 0) +
        (chunk.outputTokens ?? 0) +
        (chunk.cacheReadTokens ?? 0) +
        (chunk.cacheWriteTokens ?? 0)
    }
    // Both providers already emit `truncated` on the stop chunk; reading it here is
    // what turns the signal into something the score can act on.
    if (chunk.truncated) truncated = true
  }
  return { code: stripCodeFences(text), truncated, tokens, usageReported }
}

export interface TaskPerformanceOptions {
  /**
   * 跑哪些题。**选择**与**注入**是两件事：捕获率需要「同一批题、注入 / 不注入」，
   * 而旧签名用同一个 `skill` 参数同时决定两者，`off` 臂因此表达不出来。
   */
  tasks?: PerformanceTask[]
  /** 注入的 systemPrompt。缺席 = 不注入（`off` 臂）。 */
  skillText?: string
  /** 旧参数：既选题又注入。保留为薄包装，既有调用点零改动。 */
  skill?: { name: string; text: string }
  timeoutMs?: number
}

export async function runTaskPerformance(
  llm: Llm,
  opts?: TaskPerformanceOptions,
): Promise<TaskPerformanceReport> {
  const wanted = opts?.skill?.name
  const tasks =
    opts?.tasks ?? loadPerformanceTasks().filter((t) => (t.skill ?? undefined) === wanted)
  const systemPrompt = opts?.skillText ?? opts?.skill?.text
  const results: TaskPerformanceResult[] = []
  const startedAt = Date.now()
  let tokensUsed = 0
  let anyUsageReported = false
  for (const task of tasks) {
    const { code, truncated, tokens, usageReported } = await collectGeneratedCode(
      llm,
      task.prompt,
      systemPrompt,
    )
    tokensUsed += tokens
    anyUsageReported = anyUsageReported || usageReported
    if (!code) {
      // 仪器故障与答错必须不同形：provider 连 usage 都没报 ⇒ 这次**没测到**，
      // 不能记成「模型答错」（一次上游抽风会让基线凭空掉分）。
      results.push({
        id: task.id,
        description: task.prompt,
        passed: false,
        detail: usageReported ? 'LLM 未生成代码' : '未测得结果：无文本且无 usage（仪器/上游故障）',
        ...(truncated ? { truncated: true } : {}),
        ...(usageReported ? {} : { uncertain: true }),
      })
      continue
    }
    const verdict = judgeGeneratedCode(task.testCode, code, opts)
    results.push({
      id: task.id,
      description: task.prompt,
      passed: verdict.passed,
      detail: verdict.detail,
      ...(truncated ? { truncated: true } : {}),
    })
  }
  const passed = results.filter((r) => r.passed).length
  // Score only what the model was actually given a chance to finish. A truncated
  // generation is incomplete by construction; folding those failures into the mean
  // makes the readout (and any improved/regressed verdict derived from it) depend on
  // the output cap rather than on the work.
  const scored = results.filter((r) => !r.truncated && !r.uncertain)
  const truncated = results.filter((r) => r.truncated).length
  // 与 truncated 互斥计数：一条结果可以同时带两个标记，原始计数相加会超过 total。
  const uncertain = results.filter((r) => r.uncertain && !r.truncated).length
  return {
    total: results.length,
    passed,
    score:
      scored.length > 0
        ? Math.round((scored.filter((r) => r.passed).length / scored.length) * 100)
        : 100,
    results,
    failures: results.filter((r) => !r.passed).map((r) => r.id),
    truncated,
    uncertain,
    measurable: scored.length > 0,
    durationMs: Date.now() - startedAt,
    ...(anyUsageReported ? { tokensUsed } : {}),
  }
}

export interface SkillDelta {
  skillName: string
  baseline: TaskPerformanceReport
  post: TaskPerformanceReport
  delta: number
}

interface ResolvedSkillProposal {
  skillName: string
  baselineText: string
  postText: string
}

/** 路径门：只认内置 skill 文件。 */
function isSkillFile(filePath: string): boolean {
  return (
    filePath.startsWith('apps/cli/skills/') &&
    (filePath.endsWith('.SKILL.md') || filePath.endsWith('.mipham-skill.md'))
  )
}

/**
 * 从 proposal 的路径与内容解出 skill 名（非 skill 文件 / 无 `name` → undefined）。
 * 读侧用它标注「这条证据是不是同一个任务电池上量的」（规则 8）；不与
 * `resolveSkillProposal` 合并：那个还要旧内容与任务集，这里只需一个标识。
 */
export function resolveSkillName(filePath: string, content: string): string | undefined {
  if (!isSkillFile(filePath)) return undefined
  const parsed = parseFrontmatter(content)
  return typeof parsed.data.name === 'string' ? parsed.data.name : undefined
}

/** 解析改 skill 的 proposal → 名字 + 旧/新 body；非 skill / 无任务集 / 旧不可读 → null。 */
function resolveSkillProposal(proposal: {
  filePath: string
  originalContent?: string
  newContent: string
}): ResolvedSkillProposal | null {
  if (!isSkillFile(proposal.filePath)) return null

  const newParsed = parseFrontmatter(proposal.newContent)
  const skillName = typeof newParsed.data.name === 'string' ? newParsed.data.name : undefined
  if (!skillName) return null

  if (!loadPerformanceTasks().some((t) => t.skill === skillName)) return null

  let baselineText: string
  if (proposal.originalContent !== undefined) {
    baselineText = parseFrontmatter(proposal.originalContent).content
  } else {
    try {
      baselineText = parseFrontmatter(readFileSync(proposal.filePath, 'utf-8')).content
    } catch {
      return null // 旧 skill 不可读 → 无可量
    }
  }

  return { skillName, baselineText, postText: newParsed.content }
}

/**
 * 测一个改 skill 的 proposal 的任务表现 before/after delta。
 * 返回 null：不是 skill 文件 / 无匹配任务集（无可量）。
 * A1 不破：只调 runTaskPerformance（LLM 生成 + 冻结测试判定）。
 */
export async function measureSkillDelta(
  llm: Llm,
  proposal: { filePath: string; originalContent?: string; newContent: string },
): Promise<SkillDelta | null> {
  const resolved = resolveSkillProposal(proposal)
  if (!resolved) return null

  const baseline = await runTaskPerformance(llm, {
    skill: { name: resolved.skillName, text: resolved.baselineText },
  })
  const post = await runTaskPerformance(llm, {
    skill: { name: resolved.skillName, text: resolved.postText },
  })

  // 任一侧没测到 ⇒ 没有可比的 delta（不是 0，也不是「持平」）。
  if (!baseline.measurable || !post.measurable) return null

  return {
    skillName: resolved.skillName,
    baseline,
    post,
    delta: post.score - baseline.score,
  }
}

/** 逐题两臂计数：pass/seen 分开记 —— 「没量到」不能混进分母。 */
export interface TaskEvidence {
  id: string
  basePass: number
  baseSeen: number
  postPass: number
  postSeen: number
}

export interface SkillDeltaSample {
  skillName: string
  baselineScores: number[]
  postScores: number[]
  /**
   * 空模型闸：把**空程序**喂给同一组冻结测试，通过的题数。
   * 通过 > 0 ⇒ 这些题空程序也能过，测的不是模型能力 ⇒ 改进判定不可归因。
   * 缺席 = 旧记录 / 未测（与 nullModelTotal 同生同灭）。
   */
  nullModelPassed?: number
  nullModelTotal?: number
  /**
   * B2 代价维：与分数数组**逐项对齐**的耗时（第 i 项就是产出第 i 个分数的那次采样）。
   * 缺席 = 该样本未记代价（旧记录 / 旧调用点），读侧须按「缺席」处理、不得当成 0。
   * 只记录，不参与改进判定 —— 样本量这么小的时候，再加一个维度只会让统计问题更糟。
   */
  baselineDurations?: number[]
  postDurations?: number[]
  /**
   * RSI Tax：与分数数组逐项对齐的 token 用量（第 i 项 = 产出第 i 个分数那次测量的消耗）。
   * **两个数组同生同灭**；且只有 k 次采样**全部**报了 usage 才出现 —— 少数几次没报时
   * 补齐 0 会把「没测」写成「免费」，宁可整维缺席。
   */
  baselineTokens?: number[]
  postTokens?: number[]
  /**
   * P4+：逐题两臂计数（区间计算的原料）。只含**真的量到**的采样 ——
   * uncertain / truncated 既不进 pass 也不进 seen。缺席 = 旧样本。
   */
  taskEvidence?: TaskEvidence[]
  /**
   * P4 逐题修复集：基线**测到过且全败**、改动后**测到过且至少过一次**的题 id。
   *
   * 确定性算术，无 LLM 裁判（A1）。「测到过」排除 `truncated` / `uncertain` 的采样 ——
   * 某一轮上游抽风不能算「基线失败」，否则一道根本没量到的题会被记成「被修好了」。
   * k 次采样下这是方向性信号，不是统计结论。空数组 = 测得、一题都没修好（不是缺席）。
   */
  fixedTasks?: string[]
}

/**
 * 多次采样 before/after（每次都是「LLM 生成 → 冻结测试判定」），供改进轨估噪声。
 * 返回 null 门与 measureSkillDelta 相同。**k 默认 5**：逐题修复的 Wilson 区间要到
 * 这个量级才可能分得开（k=3 时连 0/3→3/3 都相交）；成本是每次测量 2×k 次 LLM 调用。
 */
export async function measureSkillDeltaRepeated(
  llm: Llm,
  proposal: { filePath: string; originalContent?: string; newContent: string },
  opts?: { k?: number },
): Promise<SkillDeltaSample | null> {
  const resolved = resolveSkillProposal(proposal)
  if (!resolved) return null

  const k = opts?.k ?? 5
  const baselineScores: number[] = []
  const postScores: number[] = []
  const baselineDurations: number[] = []
  const postDurations: number[] = []
  const baselineTokens: number[] = []
  const postTokens: number[] = []
  // 逐题累计：只累计**真的量到**的采样（截断 / 仪器故障不是答错）。
  const perTask = new Map<
    string,
    { baseSeen: number; basePass: number; postSeen: number; postPass: number }
  >()
  const acc = (phase: 'base' | 'post', report: TaskPerformanceReport): void => {
    for (const r of report.results) {
      if (r.truncated || r.uncertain) continue
      const s = perTask.get(r.id) ?? { baseSeen: 0, basePass: 0, postSeen: 0, postPass: 0 }
      if (phase === 'base') {
        s.baseSeen++
        if (r.passed) s.basePass++
      } else {
        s.postSeen++
        if (r.passed) s.postPass++
      }
      perTask.set(r.id, s)
    }
  }
  for (let i = 0; i < k; i++) {
    const r = await runTaskPerformance(llm, {
      skill: { name: resolved.skillName, text: resolved.baselineText },
    })
    // 没测到的一轮不许折成 100 塞进样本：那会把「上游挂了」变成「基线满分」，
    // 进而产出假的 regressed（拦掉一次合法合并）或假的 improved。
    if (!r.measurable) return null
    acc('base', r)
    baselineScores.push(r.score)
    baselineDurations.push(r.durationMs)
    if (r.tokensUsed !== undefined) baselineTokens.push(r.tokensUsed)
  }
  for (let i = 0; i < k; i++) {
    const r = await runTaskPerformance(llm, {
      skill: { name: resolved.skillName, text: resolved.postText },
    })
    if (!r.measurable) return null
    acc('post', r)
    postScores.push(r.score)
    postDurations.push(r.durationMs)
    if (r.tokensUsed !== undefined) postTokens.push(r.tokensUsed)
  }
  const fixedTasks = [...perTask.entries()]
    .filter(([, s]) => s.baseSeen > 0 && s.postSeen > 0 && s.basePass === 0 && s.postPass > 0)
    .map(([id]) => id)
  const taskEvidence: TaskEvidence[] = [...perTask.entries()].map(([id, s]) => ({
    id,
    basePass: s.basePass,
    baseSeen: s.baseSeen,
    postPass: s.postPass,
    postSeen: s.postSeen,
  }))

  // 空模型闸在最后一次采样后算一次：与模型无关，重复跑只是重复同一组测试。
  const nullCheck = runNullModelCheck(resolved.skillName)

  return {
    skillName: resolved.skillName,
    baselineScores,
    postScores,
    baselineDurations,
    postDurations,
    // 完整 k 次才写：少数几次没报 usage 时补 0 等于把「没测」写成「免费」。
    ...(baselineTokens.length === k && postTokens.length === k
      ? { baselineTokens, postTokens }
      : {}),
    nullModelPassed: nullCheck.passed,
    nullModelTotal: nullCheck.total,
    fixedTasks,
    taskEvidence,
  }
}
