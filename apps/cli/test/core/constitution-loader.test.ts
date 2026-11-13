import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConstitutionLoader } from '../../src/core/constitution-loader'

/**
 * `scope` carries two different things in the vocabulary: a hook phase
 * (`all-tools`, `pre-inference`, `post-tool-use`) and a comma-separated tool
 * list (`"Write,Edit,Bash"`). `getPrinciplesForTool` read the phase and the
 * `tools[]` array, never the comma list — so `no-credential-leak`, the one
 * entry spelled in the comma form, applied to **no tool at all** while its
 * neighbours (which declare `tools[]` as well) worked fine.
 *
 * A rule that is never selected cannot block anything, and nothing about it
 * looks wrong: the vocabulary parses, the principle renders in `/constitution`,
 * and every test that fed the gate a hand-built principle stayed green.
 */

const loader = new ConstitutionLoader(
  // Own path: the loader writes a default guardrails file when none exists.
  join(mkdtempSync(join(tmpdir(), 'constitution-')), 'ai-guardrails.yml'),
)

const ids = (tool: string) => loader.getPrinciplesForTool(tool).map((p) => p.id)

describe('ConstitutionLoader.getPrinciplesForTool', () => {
  it('applies a comma-separated scope to each tool it names', () => {
    for (const tool of ['Write', 'Edit', 'Bash']) {
      expect(ids(tool), `${tool} should enforce no-credential-leak`).toContain('no-credential-leak')
    }
  })

  it('does not apply that principle outside the three tools it names', () => {
    expect(ids('Read')).not.toContain('no-credential-leak')
  })

  it('still applies all-tools principles everywhere', () => {
    expect(ids('Read')).toEqual(expect.arrayContaining(['never-fabricate', 'respect-permissions']))
  })

  it('still matches a `tools[]` array', () => {
    expect(ids('Write')).toEqual(expect.arrayContaining(['minimal-change', 'simplicity-first']))
    expect(ids('Bash')).toContain('no-destructive-without-confirmation')
  })

  it('leaves hook-phase scopes off tool calls', () => {
    // `pre-inference` / `post-tool-use` name hooks, not tools; treating them as
    // tool names would be the mirror image of the same bug.
    for (const tool of ['Write', 'Edit', 'Bash', 'Read']) {
      expect(ids(tool)).not.toContain('think-before-coding')
      expect(ids(tool)).not.toContain('persist-crsi-learning')
    }
  })
})
