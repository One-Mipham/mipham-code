/**
 * Skip accounting for a vitest JSON report.
 *
 * `numTotalTests` counts **registered** tests, skipped ones included. So a run
 * whose whole `test/e2e/full-pipeline.test.ts` describe was skipped (no provider
 * API key) still sums to the registry value and passes the count gate — the only
 * trace is a skip number nobody reads. On 2026-11-26 a self-assessment reported
 * exactly such a run as "全量测试实跑…数字对上了".
 *
 * This module makes the run falsifiable: every skipped file must be registered
 * below with an allowed count, and a registered warning is printed when the only
 * end-to-end suite did not execute. An unregistered skip is a hard failure — the
 * alternative (silently counting it) is how "5,339 executed" got reported as
 * "5,349 对上了".
 *
 * `allowed` is a closed set, not a ceiling: a file that skips at all must skip
 * an allowed number. A file that skips **zero** times is never reported — a
 * disappearing skip is the good direction, and a deleted test still moves the
 * total (the count gate catches it). The dangerous direction is silently *more*
 * skips, and that is the one this guards.
 */

interface SkipRule {
  /** Allowed skipped-test counts. An all-or-nothing describe is `[0, N]`. */
  allowed: readonly number[]
  /** Why this file is allowed to skip. */
  reason: string
  /** Printed as a warning whenever this file actually skipped. */
  warning?: string
}

export const KNOWN_SKIP_SOURCES: Readonly<Record<string, SkipRule>> = {
  'test/mcp/oauth.test.ts': {
    allowed: [2],
    reason: 'it.skip ×2 —— PKCE / token-store 用例需要真实 provider 往返',
  },
  'test/e2e/full-pipeline.test.ts': {
    allowed: [0, 8],
    reason: '无 provider API key 时 describe.skip（全有或全无）',
    warning:
      'E2E 全链路 8 条未执行（无 provider key）—— CI 从不提供 key，' +
      '所以「全绿」不含任何端到端执行',
  },
  'test/tools/file.test.ts': {
    allowed: [0, 3],
    reason: 'it.skipIf(win32) —— 平台条件跳过',
  },
  'test/integrity/crsi-sandbox-root.test.ts': {
    allowed: [0],
    reason: 'skipIf(stryker) —— 只应出现在变异运行里；干净报告不该跳过',
  },
}

export interface TestReportAudit {
  /** Tests that actually ran (passed + failed). */
  executed: number
  /** Tests registered but not executed. */
  skipped: number
  total: number
  /** Per-file skip accounting, in report order. */
  byFile: Array<{ file: string; skipped: number; reason: string }>
  /** Any deviation from `KNOWN_SKIP_SOURCES` — a hard failure for the caller. */
  problems: string[]
  /** Registered conditions worth saying out loud (e.g. e2e did not run). */
  warnings: string[]
}

interface AssertionResult {
  status?: unknown
}

interface TestFileResult {
  name?: unknown
  assertionResults?: unknown
}

/** `/…/apps/cli/test/x.test.ts` → `test/x.test.ts`. */
function relativeToCli(name: string): string {
  const marker = '/apps/cli/'
  const at = name.lastIndexOf(marker)
  if (at >= 0) return name.slice(at + marker.length)
  const m = /(?:^|\/)(test\/.*)$/.exec(name)
  return m?.[1] ?? name
}

export function auditTestReport(report: unknown): TestReportAudit {
  const r = report as { testResults?: unknown; numTotalTests?: unknown }
  if (!Array.isArray(r.testResults)) {
    throw new Error('测试报告里没有 testResults —— 请确认是用 `--reporter=json` 产出的报告')
  }

  let executed = 0
  let skipped = 0
  const perFile = new Map<string, number>()

  for (const file of r.testResults as TestFileResult[]) {
    const name = typeof file.name === 'string' ? relativeToCli(file.name) : '<unknown>'
    const results = Array.isArray(file.assertionResults)
      ? (file.assertionResults as AssertionResult[])
      : []
    let fileSkipped = 0
    for (const a of results) {
      if (a.status === 'passed' || a.status === 'failed') executed++
      else {
        skipped++
        fileSkipped++
      }
    }
    if (fileSkipped > 0) perFile.set(name, fileSkipped)
  }

  const byFile: TestReportAudit['byFile'] = []
  const problems: string[] = []
  const warnings: string[] = []

  for (const [file, count] of perFile) {
    const rule = KNOWN_SKIP_SOURCES[file]
    if (!rule) {
      byFile.push({ file, skipped: count, reason: '未登记' })
      problems.push(
        `${file}: 跳过 ${count} 条，但没有登记在 KNOWN_SKIP_SOURCES 里 —— ` +
          `是新跳过源，还是测试开始整段失败？`,
      )
      continue
    }
    byFile.push({ file, skipped: count, reason: rule.reason })
    if (!rule.allowed.includes(count)) {
      problems.push(
        `${file}: 跳过 ${count} 条，允许的是 ${rule.allowed.join('/')} —— ` +
          `跳过集合变了（${rule.reason}）`,
      )
    }
    if (rule.warning) warnings.push(rule.warning)
  }

  const total =
    typeof r.numTotalTests === 'number' && Number.isInteger(r.numTotalTests)
      ? r.numTotalTests
      : executed + skipped
  if (total !== executed + skipped) {
    problems.push(
      `报告自相矛盾：numTotalTests=${total}，但逐条统计是 ${executed} executed + ${skipped} skipped`,
    )
  }

  return { executed, skipped, total, byFile, problems, warnings }
}

export function formatTestReportAudit(audit: TestReportAudit): string {
  const lines = [
    `🧮 测试执行账：executed=${audit.executed} skipped=${audit.skipped} total=${audit.total}`,
  ]
  for (const f of audit.byFile) {
    lines.push(`   • ${f.file}: skipped=${f.skipped}（${f.reason}）`)
  }
  for (const w of audit.warnings) lines.push(`   ⚠️  ${w}`)
  for (const p of audit.problems) lines.push(`   ❌ ${p}`)
  return lines.join('\n')
}
