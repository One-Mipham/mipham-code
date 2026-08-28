import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { execSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'
import type { InstructionFile } from '../shared/index.ts'
import { COAUTHOR_TRAILER } from '../shared/index.ts'
import {
  LESSONS_FILE,
  extractCrsiLessonSummaries,
  buildCrsiLessonsBlock,
  type CrsiLessonSummary,
} from './crsi-producer'

interface FrontmatterResult {
  data: Record<string, unknown>
  content: string
}

function parseFrontmatter(raw: string): FrontmatterResult {
  // Strip a leading UTF-8 BOM — otherwise `^---` never matches and a
  // BOM-prefixed file is silently treated as body text (effectively ignored).
  const src = raw.replace(/^\uFEFF/, '')
  const match = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: src }
  }
  return {
    data: parseYaml(match[1] || '') as Record<string, unknown>,
    content: match[2] || '',
  }
}

/** Strip the named sections (by heading title) from a markdown document. */
export function stripSections(content: string, excluded: string[]): string {
  if (excluded.length === 0) return content
  const lines = content.split('\n')
  const out: string[] = []
  let skipLevel = 0
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+?)\s*$/)
    if (m) {
      const level = m[1]!.length
      const title = m[2]!.trim()
      if (excluded.includes(title)) {
        skipLevel = level
      } else if (skipLevel > 0 && level <= skipLevel) {
        skipLevel = 0
      }
    }
    if (skipLevel === 0) out.push(line)
  }
  return out.join('\n')
}

/** Normalize a `prompt-exclude` frontmatter value (YAML list or single string). */
export function parsePromptExclude(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (typeof value === 'string') return [value]
  return []
}

/** 定位仓库根（git rev-parse --show-toplevel），非 git 目录回退 cwd。 */
export function gitRoot(cwd: string): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd,
      timeout: 5000,
      encoding: 'utf-8',
    }).trim()
  } catch {
    return cwd
  }
}

/** 从仓库根到 cwd 的目录链（含两端），就近（cwd）在最后。cwd 不在 root 下时退化为 [cwd]。 */
export function discoverDirectories(root: string, cwd: string): string[] {
  const absRoot = resolve(root)
  const absCwd = resolve(cwd)
  if (absCwd === absRoot) return [absRoot]

  const rel = relative(absRoot, absCwd)
  if (rel.startsWith('..') || isAbsolute(rel)) return [absCwd]

  const dirs = [absRoot]
  let cur = absRoot
  for (const seg of rel.split(sep)) {
    cur = join(cur, seg)
    dirs.push(cur)
  }
  return dirs
}

/**
 * 每目录内指令文件的读取顺序（后加载 = 更高优先级）。
 * AGENTS.md（行业标准基线）→ AGENTS.override.md（Codex 覆盖层）→
 * MIPHAM.md（Mipham 品牌）→ CLAUDE.md（Claude Code 兼容）。
 * MIPHAM→CLAUDE 相对顺序保持现状不变，仅前置 AGENTS 两条，避免行为回归。
 */
export const INSTRUCTION_FILENAMES = [
  'AGENTS.md',
  'AGENTS.override.md',
  'MIPHAM.md',
  'CLAUDE.md',
] as const

export class InstructionsLoader {
  private instructions: InstructionFile[] = []
  private crsiLessonSummaries: CrsiLessonSummary[] = []

  loadAll(cwd: string): void {
    this.instructions = []
    const root = gitRoot(cwd)

    // Tier 1: 集团/公司策略（锚定仓库根，从任意子目录启动都正确；不读 AGENTS.md）
    this.tryLoad(join(root, '..', '..', 'CLAUDE.md'), 'group') // Rismed_Ronxin_Capital
    this.tryLoad(join(root, '..', 'CLAUDE.md'), 'company') // One_Mipham_Corporation
    this.tryLoad(join(root, '..', 'MIPHAM.md'), 'group')

    // Tier 2: 递归项目层 — git 根 → cwd，逐目录读，就近（cwd）最后 = 优先级最高
    const dirs = discoverDirectories(root, cwd)
    dirs.forEach((dir, i) => {
      const level: InstructionFile['level'] = i === dirs.length - 1 ? 'project' : 'directory'
      for (const name of INSTRUCTION_FILENAMES) {
        this.tryLoad(join(dir, name), level)
      }
    })

    // Tier 3: 用户层 ~/.mipham/USER.md
    const home = process.env.HOME || '~'
    this.tryLoad(join(home, '.mipham', 'USER.md'), 'user')

    // CRSI 教训召回：读 crsi-lessons.md 提取精华，注入系统提示（只写不读 → 写后召回）
    this.crsiLessonSummaries = this.loadCrsiLessons(root)
  }

  buildSystemPrompt(permissionMode?: string): string {
    const parts: string[] = []

    for (const inst of this.instructions) {
      // Honor `privacy: private` — such instructions are never sent to the model.
      if (inst.privacy === 'private') continue

      const levelLabel: Record<string, string> = {
        group: 'Group Policy',
        company: 'Company Policy',
        project: 'Project Rules',
        directory: 'Directory Rules',
        user: 'User Preferences',
      }
      // Strip doc-only sections declared via `prompt-exclude` frontmatter
      // (changelog/roadmap/catalog are human-facing, not machine rules).
      const content = stripSections(
        inst.content,
        parsePromptExclude(inst.frontmatter['prompt-exclude']),
      )
      parts.push(`<!-- ${levelLabel[inst.level] || inst.level} (${inst.path}) -->\n${content}`)
    }

    // P2-2: Inject current permission mode so the model knows its constraints
    if (permissionMode) {
      parts.push(this.buildPermissionContext(permissionMode))
    }

    // 开场克制：寒暄只回一句短问候，不上能力清单（避免把「你好」当「你是谁」处理）
    parts.push(`## Greeting Restraint

When the user's message is only a greeting or small talk ("hello", "hi",
"你好", "您好", "在吗", "早上好"), reply with ONE brief, warm line —
e.g. "你好，我是 Mipham，有什么可以帮你的？" Do NOT introduce yourself,
list your capabilities/tools/MCP servers, or enumerate what you can do.
Only describe your capabilities when the user explicitly asks ("你是谁",
"你能做什么", "what can you do", "introduce yourself").`)

    // Inject critical thinking self-check layer (for analysis/comparison tasks)
    parts.push(`## Critical Thinking Self-Check

Before delivering any analysis, comparison, evaluation, or "X vs Y"
report, run this checklist internally:

### 1. Evidence Standard
- Every factual claim MUST cite a specific source (file path, URL, line number)
- If you cannot cite a source, label the claim as [推断] (inference) or [待验证] (unverified)
- Numbers (counts, percentages, download stats) require cross-validation from a second source

### 2. Equivalence Verification
- When you claim "A is equivalent to B" or "X has been merged from Y",
  compare their ACTUAL implementation, not just their names or descriptions
- If you haven't read both implementations, say "appears similar at the
  description level; implementation equivalence not verified"

### 3. Counter-Example Search
- For each major conclusion, find at least 1 counter-example or edge case
- If you cannot find one, state that explicitly: "No counter-example found
  within the examined scope"
- When comparing two systems, ask: "What does X do that Y CANNOT do?"
  (and vice versa) — don't just list overlaps

### 4. Confidence Calibration
- Label each conclusion with confidence: [高] [中] [低]
- [高] = verified from source code or primary documentation
- [中] = inferred from description but not implementation-verified
- [低] = speculative, based on naming convention or surface similarity

### 5. Depth Check
- If your analysis is based ONLY on file names and description fields,
  you are doing surface analysis — state this limitation upfront
- To reach depth: read at least one implementation file per comparison target
- Ask: "What would a domain expert notice that I'm missing?"

These checks are not optional for analysis tasks. Apply them before
presenting conclusions, and surface any [低] confidence findings
explicitly rather than burying them.`)

    // Inject workflow auto-generation guidance
    parts.push(`## Workflow Auto-Generation

When a task involves 3+ independent subtasks, multi-file operations,
or unknown-size discovery, generate a workflow script and execute it
via the Workflow tool instead of running agents sequentially. The
orchestration itself is code (zero tokens for inter-agent coordination).

Prefer workflows for: audits across many files, web research with multiple
sources, code migrations touching many files, security scans, bug hunts
with unknown scope, multi-dimensional code reviews.

Available primitives: agent(), parallel(), pipeline(), verify(),
judge(), loopUntilConvergence(), phase(), log(), args, budget.

Key rules:
- Default to pipeline() — only use parallel() barrier when a stage
  genuinely needs all prior results at once
- Edge logic (flatten, dedupe, filter) is plain JS — not agent calls
- Use verify() on edges where confidence matters
- Use loopUntilConvergence() for discovery tasks with unknown size

When a workflow completes successfully, offer to save it:
"Workflow complete. Save this script? /workflow save <name>"

Script format: export const meta = { name, description, phases: [...] }
// script body using primitives...`)

    // Inject code search conventions — prefer dedicated tools over raw Bash
    parts.push(`## Code Search Conventions

- Prefer the **Grep** tool for file-content search — it runs ripgrep (rg),
  10× faster than grep, with automatic fallback to grep if rg is unavailable
- Use the **Glob** tool to find files by name pattern, then Grep to search
  their contents — narrow scope before full-text search
- Use **Bash** with grep/rg/find ONLY for complex multi-step pipelines
  (e.g., pipe to sort | uniq -c | sort -rn, or chained find + xargs)
- Grep tool handles rg→grep fallback automatically; no need to
  pre-check for rg availability or manually fall back
- When you need to search AND read results: Glob → Grep → Read
  (find files, search contents, then read the matching files)`)

    // CRSI 能力自报告 — 回答自身能力边界前先查实时状态，勿凭静态清单推断
    parts.push(`## Capability Self-Report Rule

When asked about your own capabilities ("what can you do", "what do you
have / what is missing", "are you able to X"), do NOT infer the answer
from your static tool list. Run \`/crsi inventory\` first and answer from
its live CRSI / SIS / constitution state. Report the numbers you read
from it as live counts; if it shows a subsystem as 未初始化 (uninitialized),
say so explicitly instead of claiming it exists.`)

    // CRSI 先读代码铁律 — 回答代码问题前必须先读实际代码，勿凭记忆/命名/静态清单下结论
    parts.push(`## Read-Code-First Rule

Before answering ANY question about this codebase — whether a file,
function, feature, or capability exists, how it works, or whether
something is missing — you MUST first read the actual code with the
Read, Grep, Glob, or graft tools. Do not infer or assert from memory,
naming conventions, or static tool lists. If you have not read the code,
say so and read it first, rather than answering hastily and retracting
afterwards. This applies to every code question, not only research or
borrow-analysis tasks.`)

    // CRSI 教训召回 — 把 crsi-lessons.md 的教训精华注入，让模型「写后召回」而非只写不读
    const lessonsBlock = buildCrsiLessonsBlock(this.crsiLessonSummaries)
    if (lessonsBlock) parts.push(lessonsBlock)

    // AI 署名披露：提交时附带 Co-Authored-By 署名（与 Undercover 式隐瞒相反）
    parts.push(`## Commit Attribution

When you create a git commit, always append this trailer on its own line
at the end of the commit message, disclosing AI involvement:

${COAUTHOR_TRAILER}

Never omit it or present the work as purely human-authored.`)

    return parts.join('\n\n---\n\n')
  }

  /** 读 crsi-lessons.md（按仓库根定位）提取教训精华。读不到则返回空。 */
  private loadCrsiLessons(root: string): CrsiLessonSummary[] {
    try {
      const content = readFileSync(join(root, LESSONS_FILE), 'utf-8')
      return extractCrsiLessonSummaries(content)
    } catch {
      return []
    }
  }

  /**
   * P2-2: Build a permission-mode context block for the system prompt.
   * Tells the model its current permission level and what to expect.
   */
  private buildPermissionContext(mode: string): string {
    const modeDescriptions: Record<string, string> = {
      default:
        'You are in **default** mode. Tools marked as requiring approval will be blocked. Use Read/Grep/Glob for exploration.',
      acceptEdits:
        'You are in **acceptEdits** mode. File reads and edits are allowed; Bash requires approval.',
      plan: 'You are in **plan** mode. Only Read/Grep/Glob are allowed — no file modifications or command execution.',
      bypassPermissions:
        'You are in **bypassPermissions** mode. All tools are allowed. Use this power responsibly.',
    }

    const description = modeDescriptions[mode]
    if (!description) return ''

    return `## Permission Context\n\n${description}\n\nWhen a tool is denied, do NOT retry it or any other approval-gated tool — Bash, WebSearch, network, and Workflow are all blocked in this mode. If the task genuinely needs a blocked tool, STOP retrying and ask the user to switch to bypassPermissions (Shift+Tab) or add an allow rule (/permissions), then wait for the user's answer.`
  }

  list(): InstructionFile[] {
    return [...this.instructions]
  }

  private tryLoad(path: string, level: InstructionFile['level']): void {
    if (!existsSync(path)) return

    try {
      const raw = readFileSync(path, 'utf-8')
      const { data, content } = parseFrontmatter(raw)
      this.instructions.push({
        path,
        level,
        privacy: (data.privacy as InstructionFile['privacy']) || 'project',
        language: (data.language as string) || 'en-US',
        content,
        frontmatter: data,
      })
    } catch {
      // Silently skip unreadable files
    }
  }
}
