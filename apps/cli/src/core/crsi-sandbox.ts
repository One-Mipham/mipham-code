/**
 * CRSI Phase 3: Security Sandbox for Controlled Code Self-Modification
 *
 * Provides a safe execution environment where AI-generated code changes
 * are:
 *   1. Applied in an isolated git worktree (no effect on working tree)
 *   2. Validated against the full test suite
 *   3. Auto-rolled back on failure
 *   4. Gated by human approval before merging
 *
 * Architecture:
 *   AI proposes change → CrsiSandbox applies in worktree → runs tests →
 *   if pass → presents diff for human approval → if approved → merges
 *   if fail → auto-discards worktree → logs failure for CRSI learning
 */

import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

// ── Types ──

export interface CrsiModification {
  /** Unique ID for this modification attempt */
  id: string
  /** Human-readable description of what this change does */
  description: string
  /** The file path (relative to repo root) to modify */
  filePath: string
  /** The file content after modification */
  newContent: string
  /** The original file content (for rollback verification) */
  originalContent: string
  /** CRSI insight that triggered this modification */
  crsiInsightId?: string
  /** CRSI rule that generated this modification */
  crsiRuleId?: string
  /** Timestamp */
  timestamp: string
}

export interface CrsiModificationResult {
  modification: CrsiModification
  /** Whether the modification was applied successfully */
  applied: boolean
  /** Test results after applying the modification */
  testResult?: CrsiTestResult
  /** Git diff of the change */
  diff?: string
  /** Error message if something failed */
  error?: string
  /** Current phase of the sandbox pipeline */
  phase:
    'pending' | 'applied' | 'testing' | 'passed' | 'failed' | 'approved' | 'merged' | 'rolled-back'
}

export interface CrsiTestResult {
  /** Whether all tests passed */
  passed: boolean
  /** Total test count */
  totalTests: number
  /** Failed test count */
  failedTests: number
  /** Test output (truncated) */
  output: string
}

export interface CrsiSessionReport {
  sessionId: string
  modifications: CrsiModificationResult[]
  summary: {
    total: number
    applied: number
    passed: number
    merged: number
    rolledBack: number
  }
  startedAt: string
  completedAt?: string
}

// ── Constants ──

const WORKTREE_PREFIX = 'crsi-sandbox-'
const TEST_TIMEOUT_MS = 120_000 // 2 minutes
const REPORT_DIR = join(homedir(), '.mipham', 'crsi-sandbox')

/**
 * 自改进循环的只读边界（信任域隔离）。
 *
 * 这些路径是 CRSI 自改进的「慢通道」——宪法、eval harness、改进机制自身。
 * 自改进循环可以改 skill/workflow/prompt/memory，但绝不能改：
 *   1. 宪法（对齐本体 + 对齐缝 + 加载器）—— 否则价值漂移会「优化」掉安全边界
 *   2. eval harness（测试套件）—— 否则会改掉自己的评估标准（Goodhart 元劫持）
 *   3. 改进机制自身（有效性追踪 / 元规则引擎 / 沙箱）—— 否则递归会改掉评估器
 *
 * 注意：这是 fail-closed 边界——宁可多拦，不可漏拦。
 */
const PROTECTED_PATHS = [
  // 宪法（对齐）
  'apps/cli/src/core/alignment-vocabulary.json',
  'apps/cli/src/core/constitution-loader.ts',
  'apps/cli/src/core/constitution-seam.ts',
  'apps/cli/src/vajra/constitution.ts',
  // eval harness
  'apps/cli/test/',
  'apps/cli/src/core/eval-harness.ts',
  'apps/cli/src/core/behavior-tasks.ts',
  'apps/cli/src/core/behavior-tasks.json',
  // 改进机制自身
  'apps/cli/src/agent/effectiveness-tracker.ts',
  'apps/cli/src/core/meta-rule-engine.ts',
  'apps/cli/src/core/crsi-sandbox.ts',
  'apps/cli/src/core/crsi-producer.ts',
  'apps/cli/src/core/proposal-guard.ts',
]

/** 是否命中只读边界。前缀匹配，目录条目以 `/` 结尾。 */
export function isProtectedPath(filePath: string): boolean {
  return PROTECTED_PATHS.some((p) => filePath === p || filePath.startsWith(p))
}

/**
 * 完整覆盖闸（blast radius）：自修改 proposal 必须声明非空 blastRadius，否则拒绝。
 *
 * 源于 2026-08-26 教训：修「思考转储」只接实时指示器、漏历史行冲刷路径——
 * 局部正确、全局遗漏。自修改前必须摸清并声明全部受影响路径，fail-closed。
 *
 * 返回错误字符串（拒绝理由），合法时返回 null。
 */
export function validateBlastRadius(proposal: { blastRadius?: string[] }): string | null {
  if (!proposal.blastRadius || proposal.blastRadius.length === 0) {
    return (
      'blast radius 未声明：自修改必须枚举触及的全部代码路径。' +
      '教训：两条渲染路径只接一条 = 局部正确全局遗漏。'
    )
  }
  return null
}

// ── Sandbox ──

export class CrsiSandbox {
  private repoRoot: string
  private worktreePath?: string
  private worktreeBranch?: string
  private sessionReport: CrsiSessionReport
  private currentModification?: CrsiModification

  constructor(repoRoot: string = process.cwd()) {
    this.repoRoot = resolve(repoRoot)
    this.sessionReport = {
      sessionId: `crsi-session-${Date.now().toString(36)}`,
      modifications: [],
      summary: { total: 0, applied: 0, passed: 0, merged: 0, rolledBack: 0 },
      startedAt: new Date().toISOString(),
    }

    // Ensure report directory exists
    mkdirSync(REPORT_DIR, { recursive: true })
  }

  // ── Public API ──

  /**
   * Stage 1: Create an isolated git worktree for safe modification.
   *
   * Creates a temporary worktree on a new branch. All subsequent
   * modifications happen in this isolated environment — the user's
   * working tree is never touched.
   */
  createWorktree(): { worktreePath: string; branch: string } {
    // Clean up any stale worktrees from previous crashed sessions
    this.cleanupStaleWorktrees()

    const branchName = `${WORKTREE_PREFIX}${randomUUID().slice(0, 8)}`
    const worktreeDir = join(tmpdir(), branchName)

    // Ensure the dir doesn't already exist
    if (existsSync(worktreeDir)) {
      rmSync(worktreeDir, { recursive: true, force: true })
    }

    try {
      execSync(`git worktree add -b "${branchName}" "${worktreeDir}" HEAD`, {
        cwd: this.repoRoot,
        timeout: 30_000,
        encoding: 'utf-8',
      })
    } catch (err) {
      throw new Error(`Failed to create CRSI worktree: ${String(err)}`)
    }

    this.worktreePath = worktreeDir
    this.worktreeBranch = branchName

    return { worktreePath: worktreeDir, branch: branchName }
  }

  /**
   * Stage 2: Apply a modification in the sandbox worktree.
   *
   * Writes the new content to the target file inside the worktree.
   * The modification is NOT applied to the user's working tree.
   */
  applyModification(mod: CrsiModification): CrsiModificationResult {
    if (!this.worktreePath) {
      return {
        modification: mod,
        applied: false,
        phase: 'pending',
        error: 'No worktree created. Call createWorktree() first.',
      }
    }

    this.sessionReport.summary.total++
    this.currentModification = mod

    const result: CrsiModificationResult = {
      modification: mod,
      applied: false,
      phase: 'pending',
    }

    const worktreeRoot = resolve(this.worktreePath)
    const targetPath = resolve(this.worktreePath, mod.filePath)

    // Path traversal guard: reject any target that resolves outside the sandbox worktree
    if (targetPath !== worktreeRoot && !targetPath.startsWith(worktreeRoot + sep)) {
      result.error = `Path traversal blocked: "${mod.filePath}" resolves outside the worktree.`
      result.phase = 'failed'
      this.sessionReport.modifications.push(result)
      return result
    }

    // Protected-path guard: the self-improvement loop must not modify the
    // constitution, eval harness, or improvement machinery itself.
    if (isProtectedPath(mod.filePath)) {
      result.error = `Protected path: "${mod.filePath}" is read-only to the self-improvement loop.`
      result.phase = 'failed'
      this.sessionReport.modifications.push(result)
      return result
    }

    // Verify the file exists in the worktree
    if (!existsSync(targetPath)) {
      result.error = `File not found in worktree: ${mod.filePath}`
      result.phase = 'failed'
      this.sessionReport.modifications.push(result)
      return result
    }

    // Verify original content matches (safety check — empty originalContent = lenient skip)
    try {
      const currentContent = readFileSync(targetPath, 'utf-8')
      if (currentContent !== mod.originalContent && mod.originalContent) {
        result.error =
          'Original content mismatch — file may have been modified since the audit. Aborting.'
        result.phase = 'failed'
        this.sessionReport.modifications.push(result)
        return result
      }
    } catch {
      // If we can't read the file, proceed anyway — it's a worktree
    }

    // Apply the modification
    try {
      writeFileSync(targetPath, mod.newContent, 'utf-8')
      result.applied = true
      result.phase = 'applied'
      this.sessionReport.summary.applied++

      // Generate diff
      try {
        result.diff = execSync(`git diff -- "${mod.filePath}"`, {
          cwd: this.worktreePath,
          timeout: 10_000,
          encoding: 'utf-8',
        })
      } catch {
        // Diff generation is best-effort
      }
    } catch (err) {
      result.error = `Failed to apply modification: ${String(err)}`
      result.phase = 'failed'
    }

    this.sessionReport.modifications.push(result)
    return result
  }

  /**
   * Stage 3: Run the test suite against the modified worktree.
   *
   * Only modifications that have been successfully applied can be tested.
   * If tests fail, the modification is marked as 'failed' and will be
   * rolled back.
   */
  runTests(): CrsiTestResult {
    if (!this.worktreePath) {
      return { passed: false, totalTests: 0, failedTests: 0, output: 'No worktree available.' }
    }

    const result: CrsiTestResult = { passed: false, totalTests: 0, failedTests: 0, output: '' }

    try {
      const output = execSync('pnpm test 2>&1', {
        cwd: this.worktreePath,
        timeout: TEST_TIMEOUT_MS,
        encoding: 'utf-8',
      })

      result.output = output.slice(-5000) // Keep last 5000 chars

      // Parse test results from vitest output
      const testMatch = output.match(/Tests\s+(\d+)\s+passed/)
      const failMatch = output.match(/(\d+)\s+failed/)
      const totalMatch = output.match(/Tests\s+(\d+)\s+passed.*?(\d+)\s+total/)

      if (totalMatch) {
        result.totalTests = parseInt(totalMatch[2]!, 10)
      }
      if (testMatch && !failMatch) {
        result.passed = true
        result.failedTests = 0
      } else if (failMatch) {
        result.failedTests = parseInt(failMatch[1]!, 10)
      }

      // Update all pending modifications to 'testing' → 'passed'/'failed'
      for (const modResult of this.sessionReport.modifications) {
        if (modResult.phase === 'applied') {
          modResult.phase = 'testing'
          modResult.testResult = result
        }
        if (modResult.phase === 'testing') {
          modResult.phase = result.passed ? 'passed' : 'failed'
          if (result.passed) {
            this.sessionReport.summary.passed++
          }
        }
      }
    } catch (err) {
      result.output = String(err).slice(0, 5000)
      result.failedTests = 1

      // Mark all applied modifications as failed
      for (const modResult of this.sessionReport.modifications) {
        if (modResult.phase === 'applied' || modResult.phase === 'testing') {
          modResult.phase = 'failed'
          modResult.testResult = result
        }
      }
    }

    return result
  }

  /**
   * Stage 4: Get the human-approvable diff of all modifications.
   *
   * Returns the full git diff so a human can review before approving.
   */
  getDiff(): string {
    if (!this.worktreePath) return ''

    try {
      return execSync('git diff', {
        cwd: this.worktreePath,
        timeout: 10_000,
        encoding: 'utf-8',
      })
    } catch {
      return '(diff unavailable)'
    }
  }

  /**
   * Stage 5: Merge modifications back to the main repo.
   *
   * ONLY call this after human approval and successful test run.
   * Cherry-picks the changes from the worktree branch to the current branch.
   */
  merge(): { success: boolean; message: string } {
    if (!this.worktreePath || !this.worktreeBranch) {
      return { success: false, message: 'No worktree to merge from.' }
    }

    // Require every modification to have passed tests before merging. A mod left
    // in 'pending'/'applied'/'testing' (tests never run or never passed) must not merge.
    const mergeable = new Set(['passed', 'approved', 'merged'])
    const blockers = this.sessionReport.modifications.filter((m) => !mergeable.has(m.phase))
    if (blockers.length > 0) {
      const phases = [...new Set(blockers.map((m) => m.phase))].join(', ')
      return {
        success: false,
        message: `${blockers.length} modification(s) not ready to merge (phase: ${phases}). Cannot merge.`,
      }
    }

    try {
      // Commit in worktree
      execSync('git add -A', { cwd: this.worktreePath, timeout: 10_000 })
      execSync(
        `git commit -m "CRSI auto-modification: ${this.sessionReport.sessionId}" --allow-empty`,
        { cwd: this.worktreePath, timeout: 10_000 },
      )

      // Cherry-pick to main repo
      const commitHash = execSync('git rev-parse HEAD', {
        cwd: this.worktreePath,
        timeout: 10_000,
        encoding: 'utf-8',
      }).trim()

      execSync(`git cherry-pick "${commitHash}"`, {
        cwd: this.repoRoot,
        timeout: 30_000,
      })

      // Mark as merged
      for (const modResult of this.sessionReport.modifications) {
        if (modResult.phase === 'passed' || modResult.phase === 'approved') {
          modResult.phase = 'merged'
        }
      }
      this.sessionReport.summary.merged = this.sessionReport.modifications.filter(
        (m) => m.phase === 'merged',
      ).length

      return {
        success: true,
        message: `Successfully merged ${this.sessionReport.summary.merged} modification(s).`,
      }
    } catch (err) {
      return { success: false, message: `Merge failed: ${String(err)}` }
    }
  }

  /**
   * Stage 5-alt: Roll back all modifications.
   *
   * Discards the worktree and all changes. Called automatically when
   * tests fail, or manually by the user if they reject the diff.
   */
  rollback(): { success: boolean; message: string } {
    if (!this.worktreePath || !this.worktreeBranch) {
      return { success: false, message: 'No worktree to roll back.' }
    }

    // Mark all modifications as rolled-back
    for (const modResult of this.sessionReport.modifications) {
      if (modResult.phase !== 'merged') {
        modResult.phase = 'rolled-back'
      }
    }
    this.sessionReport.summary.rolledBack = this.sessionReport.modifications.filter(
      (m) => m.phase === 'rolled-back',
    ).length

    // Remove the worktree
    this.removeWorktree()

    return {
      success: true,
      message: `Rolled back ${this.sessionReport.summary.rolledBack} modification(s).`,
    }
  }

  /**
   * Clean up: remove the worktree and its branch.
   * Safe to call at any time — does nothing if no worktree exists.
   */
  removeWorktree(): void {
    if (!this.worktreePath || !this.worktreeBranch) return

    try {
      // Remove worktree
      execSync(`git worktree remove --force "${this.worktreePath}"`, {
        cwd: this.repoRoot,
        timeout: 15_000,
      })
    } catch {
      // Best-effort: if worktree remove fails, try manual cleanup
      try {
        if (existsSync(this.worktreePath)) {
          rmSync(this.worktreePath, { recursive: true, force: true })
        }
        execSync(`git worktree prune`, { cwd: this.repoRoot, timeout: 10_000 })
      } catch {
        // Give up — stale worktrees will be cleaned up on next createWorktree()
      }
    }

    // Delete the branch
    try {
      execSync(`git branch -D "${this.worktreeBranch}"`, {
        cwd: this.repoRoot,
        timeout: 10_000,
      })
    } catch {
      // Branch may already be gone
    }

    this.worktreePath = undefined
    this.worktreeBranch = undefined
  }

  /**
   * Generate and persist the session report.
   */
  finalize(): CrsiSessionReport {
    this.sessionReport.completedAt = new Date().toISOString()

    // Persist to ~/.mipham/crsi-sandbox/
    const reportPath = join(REPORT_DIR, `${this.sessionReport.sessionId}.json`)
    try {
      writeFileSync(reportPath, JSON.stringify(this.sessionReport, null, 2), 'utf-8')
    } catch {
      // Best-effort persistence
    }

    // Clean up worktree
    this.removeWorktree()

    return this.sessionReport
  }

  /**
   * Get the current session report (for live status checks).
   */
  getReport(): CrsiSessionReport {
    return this.sessionReport
  }

  /**
   * Load a historical session report.
   */
  static loadReport(sessionId: string): CrsiSessionReport | null {
    const reportPath = join(REPORT_DIR, `${sessionId}.json`)
    if (!existsSync(reportPath)) return null
    try {
      return JSON.parse(readFileSync(reportPath, 'utf-8'))
    } catch {
      return null
    }
  }

  /**
   * List all session reports.
   */
  static listReports(): string[] {
    if (!existsSync(REPORT_DIR)) return []
    try {
      return readdirSync(REPORT_DIR)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => f.replace('.json', ''))
    } catch {
      return []
    }
  }

  // ── Private Helpers ──

  /**
   * Remove stale worktrees from previous sessions that may have crashed
   * before cleanup.
   */
  private cleanupStaleWorktrees(): void {
    try {
      const listOutput = execSync('git worktree list --porcelain', {
        cwd: this.repoRoot,
        timeout: 10_000,
        encoding: 'utf-8',
      })

      const worktrees = this.parseWorktreeList(listOutput)

      for (const wt of worktrees) {
        // Only clean up CRSI sandbox worktrees
        if (!wt.branch.includes(WORKTREE_PREFIX)) continue

        // Check if the worktree path still exists
        if (!existsSync(wt.path)) {
          // Stale entry — prune it
          try {
            execSync(`git worktree prune`, { cwd: this.repoRoot, timeout: 5_000 })
            execSync(`git branch -D "${wt.branch}"`, { cwd: this.repoRoot, timeout: 5_000 })
          } catch {
            // Best-effort cleanup
          }
        }
      }
    } catch {
      // Not a git repo or worktree command failed — skip cleanup
    }
  }

  private parseWorktreeList(output: string): Array<{ path: string; branch: string }> {
    const worktrees: Array<{ path: string; branch: string }> = []
    let current: { path?: string; branch?: string } = {}

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path && current.branch) {
          worktrees.push({ path: current.path, branch: current.branch })
        }
        current = { path: line.slice('worktree '.length) }
      }
      if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).replace('refs/heads/', '')
      }
    }

    if (current.path && current.branch) {
      worktrees.push({ path: current.path, branch: current.branch })
    }

    return worktrees
  }
}
