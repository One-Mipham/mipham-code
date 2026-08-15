import { describe, it, expect } from 'vitest'
import type { StreamChunk } from '../../src/shared'
import { recordLlm, replayLlm } from '../../src/providers/llm-replay'

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('llm-replay', () => {
  it('records then replays deterministically (no network)', async () => {
    const { llm, turns } = recordLlm({
      chat: async function* () {
        yield { type: 'text', content: 'A' }
        yield { type: 'stop' }
      },
    })

    const recorded = await collect(llm.chat({ model: 'm', messages: [] }))
    expect(turns).toHaveLength(1)
    expect(turns[0]!.chunks).toEqual(recorded)

    const replay = replayLlm(turns)
    const replayed = await collect(replay.chat({ model: 'x', messages: [] }))
    expect(replayed).toEqual(recorded)
  })

  it('replay exhausts quietly when out of turns', async () => {
    const replay = replayLlm([])
    const out = await collect(replay.chat({ model: 'm', messages: [] }))
    expect(out).toEqual([])
  })
})
