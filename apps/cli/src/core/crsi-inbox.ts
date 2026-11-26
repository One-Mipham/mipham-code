/**
 * CRSI signal inbox —— 让人不在场时失败信号也不蒸发。
 *
 * 缺口：`AutoMemoryEngine` 的 insight 只活在**当前进程**里（`sessionReflections`），
 * `/crsi propose` 读的是 `accumulatedInsights`。于是「学习」有一个隐含前提 ——
 * 失败发生后、进程退出前，得有人想起来敲 `/crsi propose`。人不在，信号就没了。
 *
 * 本模块把这条链拆成两段：
 *   1. **采集**（`appendSignals`）：每轮 `persist()` 把 autoApplicable 信号同步落盘
 *      到 `~/.mipham/crsi/signal-inbox.jsonl`（0600，按 category|title 幂等去重）。
 *   2. **产出**（`refreshPendingLessons`）：CLI 启动时把收件箱里**尚未并入**的信号
 *      渲染成 `~/.mipham/crsi/pending-lessons.md`。这是一份**派生视图** ——
 *      每次从「收件箱 − 已并入」重算，所以合并后会自动收缩，不需要谁去删。
 *
 * 边界：本模块**只产出候选**，不碰 `crsi-lessons.md` 本体。并入仍走
 * `/crsi propose --pending` → 沙箱 gate → 人类批准/拒绝。自动化的只是「产出」，
 * 不是「合并」—— 后者是 CRSI 的受约束自改进边界，不在这里让渡。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, parse as parsePath } from 'node:path'
import {
  LESSONS_FILE,
  buildLessonContent,
  normalizeLessonSeverity,
  type CrsiSignal,
} from './crsi-producer'
import type { CrsiInsight } from './auto-memory'
import { miphamHome } from './paths'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { appendRegularFileSync, readRegularFileSync } from '../shared/regular-file'

/** 单次最多渲染多少条 —— 一次启动塞几十条教训等于把教训淹掉。 */
export const MAX_PENDING_LESSONS = 10

export function signalInboxPath(): string {
  return join(miphamHome(), 'crsi', 'signal-inbox.jsonl')
}

export function pendingLessonsPath(): string {
  return join(miphamHome(), 'crsi', 'pending-lessons.md')
}

function signalKey(signal: CrsiSignal): string {
  return `${signal.category}::${signal.title}`
}

function lessonHeading(signal: CrsiSignal): string {
  return `## ${signal.category}: ${signal.title}`
}

/** 读收件箱；坏行跳过（一行损坏不应拖垮整个收件箱）。 */
export function readSignals(path = signalInboxPath()): CrsiSignal[] {
  const raw = readRegularFileSync(path)
  if (!raw) return []
  const out: CrsiSignal[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<CrsiSignal>
      if (typeof parsed.category !== 'string' || typeof parsed.title !== 'string') continue
      out.push({
        category: parsed.category,
        title: parsed.title,
        severity: typeof parsed.severity === 'string' ? parsed.severity : undefined,
        suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion : '',
        evidence: Array.isArray(parsed.evidence)
          ? parsed.evidence.filter((e): e is string => typeof e === 'string')
          : [],
        component: parsed.component,
      })
    } catch {
      // 坏行：跳过
    }
  }
  return out
}

/**
 * 追加信号，按 category|title 去重；返回本次实际新增条数。
 *
 * 去重是**跨调用**的（与文件里已有的比），所以同一失败反复发生不会把收件箱撑爆。
 */
export function appendSignals(signals: CrsiSignal[], path = signalInboxPath()): number {
  if (signals.length === 0) return 0

  const existing = new Set(readSignals(path).map(signalKey))
  const fresh: CrsiSignal[] = []
  for (const signal of signals) {
    const key = signalKey(signal)
    if (existing.has(key)) continue
    existing.add(key)
    fresh.push(signal)
  }
  if (fresh.length === 0) return 0

  mkdirSync(dirname(path), { recursive: true })
  const payload = fresh.map((s) => JSON.stringify(s)).join('\n') + '\n'
  return appendRegularFileSync(path, payload, { mode: 0o600 }) ? fresh.length : 0
}

/**
 * 把收件箱渲染成教训 markdown（派生视图）。
 *
 * `mergedLessons` 是 `crsi-lessons.md` 的现状：标题已在里面的信号不再出现。
 * 返回空串表示「没有该产出的东西」—— 不是一段空壳。
 */
export function pendingLessonsMarkdown(
  signals: CrsiSignal[],
  mergedLessons: string,
  timestamp: string,
): string {
  const seen = new Set<string>()
  const blocks: string[] = []
  for (const signal of signals) {
    const heading = lessonHeading(signal)
    if (mergedLessons.includes(heading) || seen.has(heading)) continue
    seen.add(heading)
    blocks.push(
      buildLessonContent(
        signal,
        timestamp,
        normalizeLessonSeverity(signal.severity),
        'CRSI inbox (auto-collected)',
      ),
    )
    if (blocks.length >= MAX_PENDING_LESSONS) break
  }
  return blocks.join('\n')
}

export function readPendingLessons(path = pendingLessonsPath()): string {
  return readRegularFileSync(path) ?? ''
}

function writePendingLessons(content: string, path = pendingLessonsPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  // 派生视图也走原子写：读侧把「读不动」当空，半截文件会把整份 pending 读没。
  atomicWriteFileSync(path, content, { mode: 0o600 })
}

/** 从 `startDir` 向上找 `apps/cli/crsi-lessons.md`（producer 的仓库内路径）。 */
export function findLessonsFile(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, LESSONS_FILE)
    if (existsSync(candidate)) return candidate
    const parent = parsePath(dir).dir
    if (parent === dir) return null
    dir = parent
  }
}

export interface RefreshResult {
  /** 当前 pending 文件里的教训条数。 */
  total: number
}

/**
 * 启动时调用：从收件箱重新派生 pending 教训。
 *
 * 不在 mipham-code 仓库里（找不到 lessons 文件）时**什么都不写** —— 这条流水线
 * 只对「能改自己教训文件」的仓库成立；用户安装里产出的 pending 无人能并入。
 */
export function refreshPendingLessons(
  startDir: string,
  opts: { inboxPath?: string; pendingPath?: string; timestamp?: string } = {},
): RefreshResult {
  const lessonsPath = findLessonsFile(startDir)
  if (!lessonsPath) return { total: 0 }

  const merged = readRegularFileSync(lessonsPath) ?? ''
  const content = pendingLessonsMarkdown(
    readSignals(opts.inboxPath),
    merged,
    opts.timestamp ?? new Date().toISOString(),
  )
  writePendingLessons(content, opts.pendingPath)
  return { total: content ? (content.match(/^## /gm)?.length ?? 0) : 0 }
}

/**
 * 收件箱信号 → `/crsi propose` 能吃的 insight 形状。
 *
 * 这是「重启后仍能学习」那一步：`produceCrsiProposal` 只认 `CrsiInsight[]`，
 * 而进程内的 `accumulatedInsights` 重启即空。
 */
export function insightsToSignals(insights: CrsiInsight[]): CrsiSignal[] {
  return insights.map((insight) => ({
    category: insight.category,
    title: insight.description,
    severity: insight.severity,
    suggestion: insight.suggestion,
    evidence: insight.evidence,
  }))
}

/**
 * 按顶层 `## ` 把教训 markdown 切成块（前言/说明不混进任何一块）。
 *
 * pending 文件是独立写的，并入前要逐块与 `crsi-lessons.md` 比对 —— 按块比对，
 * 不按整份文本比对，才能做到「只并入新的那几条」。
 */
export function splitLessonBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let current: string[] | null = null
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      if (current) blocks.push(current.join('\n'))
      current = [line]
      continue
    }
    if (current) current.push(line)
  }
  if (current) blocks.push(current.join('\n'))
  return blocks
}

export function pendingToInsights(signals: CrsiSignal[]): CrsiInsight[] {
  return signals.map((signal) => ({
    category: signal.category,
    description: signal.title,
    severity:
      signal.severity === 'critical' || signal.severity === 'warning' ? signal.severity : 'info',
    suggestion: signal.suggestion,
    evidence: signal.evidence,
    autoApplicable: true,
  }))
}
