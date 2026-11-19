import { describe, it, expect } from 'vitest'
import { reportFindingsTool } from '../../src/tools/agent/report-findings'

/**
 * `severity` on a finding (2.1.328 surface): `important` = the change adds or
 * worsens the bug, `pre_existing` = inherited, `nit` = minor. Two things have to
 * hold or the field is decoration: the schema must offer it, and the rendered
 * report must show it — an accepted-but-never-shown attribute is a value nothing
 * downstream reads.
 */

const ctx = {} as never
const call = (findings: unknown[], level = 'medium') =>
  reportFindingsTool.execute({ findings, level }, ctx)

function finding(extra: Record<string, unknown> = {}) {
  return {
    file: 'apps/cli/src/bug.ts',
    line: 12,
    summary: 'the guard runs after the write',
    failure_scenario: 'a failed write leaves the counter incremented',
    category: 'correctness',
    ...extra,
  }
}

describe('ReportFindings — finding severity', () => {
  it('schema 提供三档 severity，且 summary 不再要求「一句话」', () => {
    const findings = (
      reportFindingsTool.parameters as {
        properties: { findings: { items: { properties: Record<string, any> } } }
      }
    ).properties.findings.items.properties

    expect(findings.severity.enum).toEqual(['important', 'pre_existing', 'nit'])
    expect(findings.severity.description).toContain('important')
    expect(findings.summary.description).toBe('Statement of the defect.')
  })

  it.each(['important', 'pre_existing', 'nit'])('接受并渲染 severity=%s', async (severity) => {
    const result = await call([finding({ severity })])
    expect(result.success).toBe(true)
    expect(result.content).toContain(`[severity: ${severity}]`)
  })

  it('拒绝未知的 severity（拒绝而不是静默透传）', async () => {
    const result = await call([finding({ severity: 'blocker' })])
    expect(result.success).toBe(false)
    expect(result.error).toContain('"severity" must be important, pre_existing, or nit')
  })

  it('正对照：没有 severity 仍正常输出，且不出现 severity 标签', async () => {
    const result = await call([finding()])
    expect(result.success).toBe(true)
    expect(result.content).toContain('the guard runs after the write')
    expect(result.content).not.toContain('[severity:')
  })
})
