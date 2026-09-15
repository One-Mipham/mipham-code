import { describe, expect, it } from 'vitest'
import { Deduper, MAX_TRACKED_IDS } from '../src/dedup.js'

describe('classification', () => {
  it('calls an unseen id new and a seen id duplicate', () => {
    const deduper = new Deduper()
    expect(deduper.check('a')).toBe('new')
    expect(deduper.check('a')).toBe('duplicate')
    expect(deduper.check('a')).toBe('duplicate')
    expect(deduper.check('b')).toBe('new')
  })

  it('classifies on the id alone, whatever else the event carried', () => {
    // The caller passes only the id; this asserts the contract that makes the
    // "same id, different payload" case a duplicate rather than a second count.
    const deduper = new Deduper()
    expect(deduper.check('same-id')).toBe('new')
    expect(deduper.check('same-id')).toBe('duplicate')
  })

  it('tracks each id once even when restored from a duplicated list', () => {
    const deduper = Deduper.fromState({ ids: ['a', 'a', 'b'], evicted: 0 })
    expect(deduper.size).toBe(2)
    expect(deduper.check('b')).toBe('duplicate')
  })
})

describe('the bias is one-sided: only a definite repeat is ever discarded', () => {
  it('re-counts an id that was evicted rather than calling it a duplicate', () => {
    // Fill exactly to the cap, then push one past it so the oldest is dropped.
    const deduper = new Deduper()
    deduper.check('oldest')
    for (let i = 0; i < MAX_TRACKED_IDS - 1; i++) deduper.check(`filler-${i}`)
    expect(deduper.evicted).toBe(0)

    deduper.check('pushed-one-past')
    expect(deduper.evicted).toBe(1)
    expect(deduper.size).toBe(MAX_TRACKED_IDS)

    // The evicted id is no longer known, so it is counted again. That is the
    // intended direction: the total may be inflated, never deflated.
    expect(deduper.check('oldest')).toBe('new')
  })

  it('never lets the tracked set grow past the cap', () => {
    const deduper = new Deduper()
    for (let i = 0; i < MAX_TRACKED_IDS + 500; i++) deduper.check(`id-${i}`)
    expect(deduper.size).toBe(MAX_TRACKED_IDS)
    expect(deduper.evicted).toBe(500)
  })

  it('keeps the most recent ids, so a burst re-delivery still dedups', () => {
    const deduper = new Deduper()
    for (let i = 0; i < MAX_TRACKED_IDS + 10; i++) deduper.check(`id-${i}`)
    // The ten oldest were evicted; the newest are all still known.
    expect(deduper.check(`id-${MAX_TRACKED_IDS + 9}`)).toBe('duplicate')
    expect(deduper.check('id-0')).toBe('new')
  })
})

describe('state round trip', () => {
  it('survives toState/fromState with the eviction count intact', () => {
    const deduper = new Deduper()
    for (let i = 0; i < MAX_TRACKED_IDS + 3; i++) deduper.check(`id-${i}`)

    const restored = Deduper.fromState(deduper.toState())
    expect(restored.evicted).toBe(3)
    expect(restored.size).toBe(MAX_TRACKED_IDS)
    expect(restored.check('id-5')).toBe('duplicate')
  })

  it('treats absent or partial state as empty rather than throwing', () => {
    expect(Deduper.fromState(undefined).size).toBe(0)
    expect(Deduper.fromState({ ids: [], evicted: 0 }).size).toBe(0)
    // A corrupt file must not take the day down with it.
    expect(
      Deduper.fromState({ ids: [null, 1, 'ok'] as unknown as string[], evicted: -5 }).size,
    ).toBe(1)
    expect(Deduper.fromState({ ids: [], evicted: 1.5 }).evicted).toBe(0)
  })
})
