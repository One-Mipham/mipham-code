export const meta = {
  name: 'review',
  description: 'Code review: fan-out per dimension → judge panel → report',
  phases: [
    { title: 'Review', detail: 'multi-dimensional review' },
    { title: 'Judge', detail: 'judge panel scores findings' },
    { title: 'Report', detail: 'final review report' },
  ],
}

phase('Review')
const dimensions = ['correctness', 'security', 'performance', 'maintainability']
const rawFindings = await parallel(
  dimensions.map(
    (d) => () =>
      agent(
        `Review the code from the "${d}" lens. Return { findings: [{ severity, file, line, summary }] }`,
        {
          label: `review:${d}`,
          schema: {
            type: 'object',
            properties: {
              findings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low'] },
                    file: { type: 'string' },
                    line: { type: 'number' },
                    summary: { type: 'string' },
                    dimension: { type: 'string' },
                  },
                  required: ['severity', 'file', 'summary'],
                },
              },
            },
            required: ['findings'],
          },
        },
      ),
  ),
)

// Edge logic: dedup across dimensions (pure JS)
const allFindings = rawFindings.filter(Boolean).flatMap((r) => r.findings)
const seen = new Set()
const uniqueFindings = allFindings.filter((f) => {
  const k = `${f.file}:${f.line}:${f.summary}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})

log(`${uniqueFindings.length} unique findings across ${dimensions.length} dimensions`)

phase('Judge')
if (uniqueFindings.length === 0) {
  return 'No findings — code looks clean across all dimensions.'
}

// Judge panel: rank findings by severity
const judged = await judge(
  uniqueFindings.map((f) => ({ finding: f })),
  {
    criteria: ['severity', 'actionability', 'confidence'],
    judges: 2,
    synthesize: false,
    schema: {
      type: 'object',
      properties: {
        scores: {
          type: 'object',
          properties: {
            severity: { type: 'number' },
            actionability: { type: 'number' },
            confidence: { type: 'number' },
          },
          required: ['severity', 'actionability', 'confidence'],
        },
        notes: { type: 'string' },
      },
      required: ['scores', 'notes'],
    },
  },
)

phase('Report')
return await agent(
  `Write a code review report from ${uniqueFindings.length} findings (ranked by judge panel). Top finding: ${JSON.stringify(judged.winner)}`,
  { label: 'report' },
)
