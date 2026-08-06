export const meta = {
  name: 'judge',
  description: 'Judge panel: N competing approaches × M judges → winner + synthesis',
  phases: [
    { title: 'Generate', detail: 'generate competing approaches' },
    { title: 'Judge', detail: 'score and rank' },
    { title: 'Synthesize', detail: 'final recommendation' },
  ],
}

phase('Generate')
const problem = args.problem || (await agent('What problem are we solving?', { label: 'query' }))

const approaches = await parallel([
  () => agent(`Solve "${problem}" with an MVP-first approach.`, { label: 'gen:mvp' }),
  () => agent(`Solve "${problem}" with a risk-first approach.`, { label: 'gen:risk' }),
  () => agent(`Solve "${problem}" with a user-first approach.`, { label: 'gen:user' }),
])

const validApproaches = approaches.filter(Boolean)
log(`Generated ${validApproaches.length} approaches`)

phase('Judge')
const { winner, winnerIndex, scores, synthesis } = await judge(validApproaches, {
  criteria: ['feasibility', 'impact', 'simplicity', 'risk'],
  judges: 3,
  synthesize: true,
  schema: {
    type: 'object',
    properties: {
      scores: {
        type: 'object',
        properties: {
          feasibility: { type: 'number' },
          impact: { type: 'number' },
          simplicity: { type: 'number' },
          risk: { type: 'number' },
        },
        required: ['feasibility', 'impact', 'simplicity', 'risk'],
      },
      notes: { type: 'string' },
    },
    required: ['scores', 'notes'],
  },
})

phase('Synthesize')
return {
  problem,
  winner: `Approach #${winnerIndex + 1}`,
  scores_summary: scores.map(
    (s) => `Judge ${s.judgeIndex + 1}: approach ${s.attemptIndex + 1} = ${s.total}`,
  ),
  synthesis,
}
