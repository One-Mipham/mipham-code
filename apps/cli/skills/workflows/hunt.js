export const meta = {
  name: 'hunt',
  description: 'Bug hunt: loopUntilConvergence + adversarial verify',
  phases: [
    { title: 'Hunt', detail: 'iterative discovery + verify' },
    { title: 'Report', detail: 'synthesize findings' },
  ],
}

phase('Hunt')
const target = args.target || 'this codebase'

const { confirmed, totalSeen, rounds, converged } = await loopUntilConvergence({
  finders: [
    () => agent(`Find bugs in ${target}. Look for: null safety, race conditions, resource leaks, edge cases. Return { items: [{ file, line, summary, type }] }`,
      { label: 'hunt:general', schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, type: { type: 'string' } }, required: ['file', 'summary', 'type'] } } }, required: ['items'] } },
    ),
    () => agent(`Find security vulnerabilities in ${target}: injection, auth bypass, insecure crypto, exposed secrets. Return { items: [{ file, line, summary, type }] }`,
      { label: 'hunt:security', schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, type: { type: 'string' } }, required: ['file', 'summary', 'type'] } } }, required: ['items'] } },
    ),
  ],
  keyFn: (bug) => `${bug.file}:${bug.line}:${bug.summary}`,
  verify: async (bug) => verify(bug, {
    mode: 'adversarial',
    skeptics: 3,
    threshold: 2,
    schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
  }),
  dryRounds: 2,
  maxRounds: 10,
})

log(`${converged ? 'Converged' : 'Max rounds reached'} after ${rounds} rounds. ${totalSeen} unique bugs seen, ${confirmed.length} confirmed.`)

phase('Report')
if (confirmed.length === 0) {
  return `No confirmed bugs found after ${rounds} rounds of hunting.`
}
return await agent(
  `Write a bug report from ${confirmed.length} confirmed bugs:\n${JSON.stringify(confirmed)}`,
  { label: 'report' },
)
