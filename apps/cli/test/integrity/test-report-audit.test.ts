import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditTestReport, formatTestReportAudit } from '../../scripts/test-report-audit'

// ============================================================
// Skip accounting — "全量测试跑过了" must be falsifiable.
//
// Before this guard, a run whose whole `test/e2e/full-pipeline.test.ts`
// describe was skipped (no provider key) still summed to the registry total,
// so the count gate passed and the only trace was a skip number nobody read.
// 2026-11-26: a self-assessment reported that run as "全量测试实跑…数字对上了".
//
// The audit's job: name every skipped file with a known reason, refuse an
// unknown one, and say out loud when the only end-to-end suite did not run.
// ============================================================

/** Build a vitest-JSON-shaped report. Paths are absolute, as vitest writes them. */
function report(entries: Array<{ file: string; skipped?: number; passed?: number }>): unknown {
  let passed = 0
  let skipped = 0
  const testResults = entries.map((e) => {
    const passedHere = e.passed ?? 0
    passed += passedHere
    skipped += e.skipped ?? 0
    return {
      name: `/Users/someone/mipham-code/apps/cli/${e.file}`,
      assertionResults: [
        ...Array.from({ length: passedHere }, (_, i) => ({
          fullName: `${e.file} passed-${i}`,
          status: 'passed',
        })),
        ...Array.from({ length: e.skipped ?? 0 }, (_, i) => ({
          fullName: `${e.file} skipped-${i}`,
          status: 'skipped',
        })),
      ],
    }
  })
  return {
    numTotalTests: passed + skipped,
    numPassedTests: passed,
    numFailedTests: 0,
    numPendingTests: skipped,
    testResults,
  }
}

describe('auditTestReport — skip sources are pinned', () => {
  it('counts executed vs skipped and warns when the whole e2e suite was skipped', () => {
    const audit = auditTestReport(
      report([
        { file: 'test/mcp/oauth.test.ts', skipped: 2, passed: 10 },
        { file: 'test/e2e/full-pipeline.test.ts', skipped: 8 },
        { file: 'test/tools/bash.test.ts', passed: 190 },
      ]),
    )

    // Positive control: the fixture must actually contain skips, otherwise the
    // assertions below pass without the audit ever seeing one.
    expect(audit.skipped).toBe(10)
    expect(audit.executed).toBe(200)
    expect(audit.total).toBe(210)
    expect(audit.problems).toEqual([])
    expect(audit.warnings.join('\n')).toContain('E2E')
    expect(audit.warnings.join('\n')).toContain('未执行')
  })

  it('rejects a skip in a file no known source accounts for', () => {
    const audit = auditTestReport(
      report([{ file: 'test/tools/example.test.ts', skipped: 1, passed: 3 }]),
    )
    expect(audit.problems.join('\n')).toContain('test/tools/example.test.ts')
    expect(audit.problems.join('\n')).toContain('1')
  })

  it('rejects a partial skip of the all-or-nothing e2e describe', () => {
    const audit = auditTestReport(report([{ file: 'test/e2e/full-pipeline.test.ts', skipped: 5 }]))
    expect(audit.problems.join('\n')).toContain('test/e2e/full-pipeline.test.ts')
  })

  it('rejects a changed static-skip count', () => {
    const audit = auditTestReport(report([{ file: 'test/mcp/oauth.test.ts', skipped: 1 }]))
    expect(audit.problems.join('\n')).toContain('test/mcp/oauth.test.ts')
  })

  it('is clean when nothing was skipped', () => {
    const audit = auditTestReport(report([{ file: 'test/tools/bash.test.ts', passed: 190 }]))
    expect(audit.executed).toBe(190)
    expect(audit.skipped).toBe(0)
    expect(audit.problems).toEqual([])
    expect(audit.warnings).toEqual([])
  })

  it('throws a readable error when the report has no testResults', () => {
    expect(() => auditTestReport({ numTotalTests: 3 })).toThrow(/testResults/)
  })
})

describe('formatTestReportAudit', () => {
  it('states executed / skipped / total and lists every skipped file', () => {
    const text = formatTestReportAudit(
      auditTestReport(
        report([
          { file: 'test/mcp/oauth.test.ts', skipped: 2, passed: 10 },
          { file: 'test/tools/bash.test.ts', passed: 190 },
        ]),
      ),
    )
    expect(text).toContain('executed=200')
    expect(text).toContain('skipped=2')
    expect(text).toContain('total=202')
    expect(text).toContain('test/mcp/oauth.test.ts')
  })
})

// ============================================================
// Wiring: the CI gate must actually call the audit.
// The reports below carry the stored TEST_COUNT, so the existing count
// comparison is satisfied and only the skip audit can decide the exit code.
// ============================================================

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STORED_TEST_COUNT = (
  JSON.parse(readFileSync(join(CLI_DIR, '../../packages/shared/package-info.json'), 'utf-8')) as {
    TEST_COUNT: number
  }
).TEST_COUNT

function runCheckOn(reportBody: unknown): {
  status: number | null
  stdout: string
  stderr: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'skip-audit-'))
  try {
    const path = join(dir, 'report.json')
    writeFileSync(path, JSON.stringify(reportBody))
    const out = spawnSync(
      'bun',
      ['run', 'scripts/sync-counts.ts', '--check', '--test-report', path],
      { cwd: CLI_DIR, encoding: 'utf-8', timeout: 30_000 },
    )
    return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('sync-counts --check — skip accounting is enforced', () => {
  it('exits 1 and names the file when an unregistered skip appears', () => {
    const out = runCheckOn(
      report([{ file: 'test/tools/example.test.ts', skipped: 1, passed: STORED_TEST_COUNT - 1 }]),
    )
    expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(1)
    expect(out.stderr).toContain('test/tools/example.test.ts')
  })

  it('stays green on a clean report whose total equals the stored count', () => {
    const out = runCheckOn(report([{ file: 'test/tools/bash.test.ts', passed: STORED_TEST_COUNT }]))
    expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(0)
    expect(out.stdout).toContain(`executed=${STORED_TEST_COUNT}`)
  })
})
