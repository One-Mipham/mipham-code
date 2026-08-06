export const meta = {
  name: 'migrate',
  description: 'Code migration: discover → fan-out transform → verify → integrate',
  phases: [
    { title: 'Discover', detail: 'find migration targets' },
    { title: 'Transform', detail: 'one agent per file' },
    { title: 'Verify', detail: 'validate transformations' },
  ],
}

phase('Discover')
const pattern = args.pattern || (await agent('What code pattern needs migration? Return { pattern, replacement, reason }',
  { schema: { type: 'object', properties: { pattern: { type: 'string' }, replacement: { type: 'string' }, reason: { type: 'string' } }, required: ['pattern', 'replacement'] } },
))

const files = await agent(
  `Find all files matching pattern: ${pattern.pattern}. Return { files: [{ path }] }`,
  { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }, required: ['files'] } },
)

log(`Migrating ${files.files.length} files: ${pattern.pattern} → ${pattern.replacement}`)

phase('Transform')
const results = await pipeline(
  files.files,
  f => agent(
    `In ${f.path}, migrate "${pattern.pattern}" to "${pattern.replacement}". Reason: ${pattern.reason}. Return { path, changes, success }`,
    { label: `migrate:${f.path}`, isolation: 'worktree', schema: { type: 'object', properties: { path: { type: 'string' }, changes: { type: 'number' }, success: { type: 'boolean' } }, required: ['path', 'success'] } },
  ),
)

const succeeded = results.filter(Boolean).filter(r => r.success)
const failed = results.filter(Boolean).filter(r => !r.success)
log(`${succeeded.length} migrated, ${failed.length} failed`)

phase('Verify')
const verified = await parallel(
  succeeded.map(f => () =>
    verify({ file: f.path, migration: pattern.replacement }, {
      mode: 'perspective',
      lenses: ['correctness', 'style'],
      threshold: 1,
      schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
    }),
  ),
)

return { migrated: succeeded.length, failed: failed.length, verified: verified.filter(Boolean).filter(v => v.survives).length }
