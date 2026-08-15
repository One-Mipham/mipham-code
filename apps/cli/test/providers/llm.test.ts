import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra'
import type { Llm } from '../../src/providers/llm'
import { LLM_KEY, mountLlm } from '../../src/providers/llm'

function fakeLlm(): Llm {
  return {
    chat: async function* () {
      yield { type: 'stop' as const }
    },
  }
}

describe('llm seam', () => {
  it('mounts under ctx.llm and retrieves it', () => {
    const ctx = new Context()
    const llm = fakeLlm()
    const dispose = mountLlm(ctx, llm)
    expect(ctx.get(LLM_KEY)).toBe(llm)
    expect(ctx.get('llm')).toBe(llm)
    dispose()
    expect(ctx.get('llm')).toBeUndefined()
  })
})
