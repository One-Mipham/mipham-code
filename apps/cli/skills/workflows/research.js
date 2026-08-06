export const meta = {
  name: 'research',
  description: 'Deep research: scope → parallel search → verify → synthesize',
  phases: [
    { title: 'Scope', detail: 'define research angles' },
    { title: 'Research', detail: 'parallel web searches' },
    { title: 'Verify', detail: 'adversarial verification' },
    { title: 'Synthesize', detail: 'final report' },
  ],
}

phase('Scope')
const topic = args.topic || (await agent('What topic should we research?', { label: 'query' }))

phase('Research')
const angles = ['overview', 'technical-details', 'competitors', 'criticism', 'future-trends']
const raw = await parallel(
  angles.map(angle => () =>
    agent(`Research "${topic}" from angle: ${angle}. Return { sources: [{ title, url, keyPoint }] }`,
      { label: `research:${angle}`, schema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, keyPoint: { type: 'string' } }, required: ['title', 'keyPoint'] } } }, required: ['sources'] } },
    )),
)

const allSources = raw.filter(Boolean).flatMap(r => r.sources)
const seen = new Set()
const unique = allSources.filter(s => { const k = s.url; if (seen.has(k)) return false; seen.add(k); return true })
log(`Collected ${unique.length} unique sources`)

phase('Verify')
const verified = await parallel(
  unique.map(s => () =>
    verify({ claim: s.keyPoint, source: s.title }, {
      mode: 'adversarial',
      skeptics: 2,
      threshold: 1,
      schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
    }),
  ),
)

const credible = verified.filter(Boolean).filter(v => v.survives).map(v => v.finding)

phase('Synthesize')
const report = await agent(
  `Synthesize research report on "${topic}" from credible sources:\n${JSON.stringify(credible)}`,
  { label: 'synthesize' },
)
return report
