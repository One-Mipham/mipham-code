export const meta = {
  name: 'audit',
  description: 'Security audit: fan-out per file → verify → report',
  phases: [
    { title: 'Scope', detail: 'discover targets' },
    { title: 'Audit', detail: 'one agent per target' },
    { title: 'Verify', detail: 'adversarial verification' },
    { title: 'Report', detail: 'synthesize findings' },
  ],
}

phase('Scope')
const targets = args.targets || (await agent(
  'List all source files that need security auditing. Return { files: [{ path, reason }] }',
  { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] } } }, required: ['files'] } },
)).files

log(`Auditing ${targets.length} files`)

phase('Audit')
const raw = (await pipeline(
  targets,
  t => agent(`Security audit ${t.path}: injection, auth, crypto, secrets, input validation. Return { findings: [{ severity, file, line, summary }] }`,
    { label: `audit:${t.path}`, schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' } }, required: ['severity', 'file', 'summary'] } } }, required: ['findings'] } },
  )),
)
const findings = raw.flatMap(r => (r && r.findings) || [])

log(`Found ${findings.length} potential issues`)

phase('Verify')
const verified = await parallel(
  findings.map(f => () =>
    verify(f, {
      mode: 'adversarial',
      skeptics: 3,
      threshold: 2,
      schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
    })
  ),
)

const confirmed = verified.filter(Boolean).filter(v => v.survives).map(v => v.finding)
log(`${confirmed.length}/${findings.length} findings verified`)

phase('Report')
const report = await agent(
  `Synthesize audit report from confirmed findings:\n${JSON.stringify(confirmed)}`,
  { label: 'report' },
)
return report
