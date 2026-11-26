import { describe, it, expect } from 'vitest'
import { Context, CONSTITUTION_KEY } from '../../src/vajra'
import { createConstitution, mountConstitution } from '../../src/core/constitution-seam'
import type { ConstitutionLoader, MiphamConstitution } from '../../src/core/constitution-loader'

// The seam is the only production consumer of this contract (`src/index.tsx`
// mounts it at startup), and until now nothing exercised it: it was one of the
// three 0%-covered core files the per-file coverage floor exposed on 2026-11-26.
function stubLoader(ids: string[]): ConstitutionLoader {
  const constitution: MiphamConstitution = {
    version: 'test',
    last_modified: '2026-11-26',
    principles: ids.map((id) => ({ id, text: id, enforce: 'warn' as const })),
  }
  return { load: () => constitution } as unknown as ConstitutionLoader
}

describe('constitution-seam', () => {
  it('accepts every principle id the vocabulary knows', () => {
    const seam = createConstitution(stubLoader(['never-fabricate', 'honor-scope']))
    expect(seam.check(['never-fabricate'])).toEqual({ violations: [] })
  })

  it('reports an unknown principle id instead of silently mounting it', () => {
    const seam = createConstitution(stubLoader(['never-fabricate']))
    expect(seam.check(['never-fabricate', 'made-up'])).toEqual({ violations: ['made-up'] })
  })

  it('mountConstitution provides the seam under CONSTITUTION_KEY', () => {
    const ctx = new Context()
    const seam = createConstitution(stubLoader(['never-fabricate']))
    mountConstitution(ctx, seam)
    expect(ctx.get(CONSTITUTION_KEY)).toBe(seam)
  })
})
