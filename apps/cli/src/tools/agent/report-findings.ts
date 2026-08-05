import type { ToolDefinition } from '../../shared/index.ts'

export const reportFindingsTool: ToolDefinition = {
  name: 'ReportFindings',
  description:
    'Report code-review findings as a typed list. ' +
    'Use this to output structured review results with file, line, summary, ' +
    'failure_scenario, and category. Findings are ranked most-severe first.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'xhigh', 'max'],
        description: 'Effort level the review ran at.',
      },
      findings: {
        type: 'array',
        description: 'Verified findings, most-severe first; empty if none survived.',
        minItems: 0,
        maxItems: 32,
        items: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'Repo-relative path of the file the finding is in.',
            },
            line: {
              type: 'integer',
              description: '1-indexed line the finding anchors to.',
            },
            summary: {
              type: 'string',
              description: 'One-sentence statement of the defect.',
            },
            short_summary: {
              type: 'string',
              maxLength: 60,
              description: 'Compressed label for compact UI (≤60 chars).',
            },
            failure_scenario: {
              type: 'string',
              description: 'Concrete inputs/state → wrong output/crash.',
            },
            category: {
              type: 'string',
              maxLength: 40,
              description:
                'Short kebab-case slug: correctness, security, performance, simplification, test-coverage, etc.',
            },
            verdict: {
              type: 'string',
              enum: ['CONFIRMED', 'PLAUSIBLE'],
              description: 'Set when a verify pass ran; absent on inline-only reviews.',
            },
            outcome: {
              type: 'string',
              enum: ['fixed', 'skipped', 'no_change_needed'],
              description:
                'Set ONLY when re-reporting after applying fixes: what happened to this finding.',
            },
          },
          required: ['file', 'summary', 'failure_scenario'],
        },
      },
    },
    required: ['findings'],
  },

  async execute(params, _ctx) {
    const findings = params.findings as Array<Record<string, unknown>> | undefined
    const level = (params.level as string) || 'medium'

    if (!Array.isArray(findings)) {
      return {
        success: false,
        content: '',
        error: 'findings must be an array',
      }
    }

    // Validate each finding has required fields
    const errors: string[] = []
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i]!
      if (!f.file || typeof f.file !== 'string') {
        errors.push(`findings[${i}]: "file" is required and must be a string`)
      }
      if (!f.summary || typeof f.summary !== 'string') {
        errors.push(`findings[${i}]: "summary" is required and must be a string`)
      }
      if (!f.failure_scenario || typeof f.failure_scenario !== 'string') {
        errors.push(`findings[${i}]: "failure_scenario" is required and must be a string`)
      }
      if (f.line !== undefined && typeof f.line !== 'number') {
        errors.push(`findings[${i}]: "line" must be an integer if provided`)
      }
      if (f.verdict && !['CONFIRMED', 'PLAUSIBLE'].includes(f.verdict as string)) {
        errors.push(`findings[${i}]: "verdict" must be CONFIRMED or PLAUSIBLE`)
      }
      if (
        f.outcome &&
        !['fixed', 'skipped', 'no_change_needed'].includes(f.outcome as string)
      ) {
        errors.push(`findings[${i}]: "outcome" must be fixed, skipped, or no_change_needed`)
      }
    }

    if (errors.length > 0) {
      return {
        success: false,
        content: '',
        error: `Validation errors:\n${errors.map((e) => `  • ${e}`).join('\n')}`,
      }
    }

    if (findings.length === 0) {
      return {
        success: true,
        content: `── Review Findings (${level} effort) ──\n\n✅ No findings to report.\n\nAll checks passed at ${level} effort level.`,
      }
    }

    // Format findings as a structured report
    const lines: string[] = [
      `── Review Findings (${level} effort) ──`,
      '',
      `${findings.length} finding${findings.length === 1 ? '' : 's'}:`,
      '',
    ]

    // Group by category for readability
    const byCategory = new Map<string, Array<Record<string, unknown>>>()
    for (const f of findings) {
      const cat = (f.category as string) || 'uncategorized'
      const list = byCategory.get(cat) || []
      list.push(f)
      byCategory.set(cat, list)
    }

    const CATEGORY_ICONS: Record<string, string> = {
      correctness: '🔴',
      security: '🔒',
      performance: '⚡',
      simplification: '🧹',
      efficiency: '⏱️',
      'test-coverage': '🧪',
      architecture: '🏗️',
      maintainability: '🔧',
    }

    for (const [category, items] of byCategory) {
      const icon = CATEGORY_ICONS[category] || '📌'
      lines.push(`${icon} ${category} (${items.length}):`)
      for (const f of items) {
        const verdict = f.verdict ? ` [${f.verdict}]` : ''
        const outcome = f.outcome ? ` → ${f.outcome}` : ''
        const lineRef = f.line ? `:${f.line}` : ''
        lines.push(`  • ${f.file}${lineRef}${verdict}${outcome}`)
        lines.push(`    ${f.summary}`)
        if (f.failure_scenario) {
          const scenario =
            (f.failure_scenario as string).length > 120
              ? (f.failure_scenario as string).slice(0, 120) + '...'
              : (f.failure_scenario as string)
          lines.push(`    💥 ${scenario}`)
        }
      }
      lines.push('')
    }

    // Severity summary
    const confirmed = findings.filter((f) => f.verdict === 'CONFIRMED').length
    const plausible = findings.filter((f) => f.verdict === 'PLAUSIBLE').length
    if (confirmed > 0 || plausible > 0) {
      lines.push(
        `📊 ${confirmed} CONFIRMED · ${plausible} PLAUSIBLE · ${findings.length - confirmed - plausible} unverified`,
      )
    }

    return {
      success: true,
      content: lines.join('\n'),
    }
  },
}
