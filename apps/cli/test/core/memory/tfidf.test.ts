import { describe, it, expect } from 'vitest'
import { tokenize, cosine, similarities, findNearDuplicates } from '../../../src/core/memory/tfidf'

describe('tokenize', () => {
  it('emits character bigrams for CJK runs', () => {
    expect(tokenize('语义召回')).toEqual(['语义', '义召', '召回'])
  })

  it('lowercases and keeps ASCII words of length ≥ 2', () => {
    expect(tokenize('Mipham Code')).toEqual(['mipham', 'code'])
  })

  it('emits a single CJK char for a one-char run', () => {
    expect(tokenize('版本 发布')).toEqual(['版本', '发布'])
  })

  it('skips punctuation and single-char ASCII words', () => {
    expect(tokenize('C++ 和 v1.2')).toEqual(['和', 'v1'])
  })
})

describe('cosine', () => {
  const vec = (entries: Array<[string, number]>) => new Map(entries)

  it('returns 1 for identical vectors', () => {
    expect(
      cosine(
        vec([
          ['a', 1],
          ['b', 1],
        ]),
        vec([
          ['a', 1],
          ['b', 1],
        ]),
      ),
    ).toBeCloseTo(1)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosine(vec([['a', 1]]), vec([['b', 1]]))).toBe(0)
  })

  it('returns 0 when either vector is empty', () => {
    expect(cosine(vec([]), vec([['a', 1]]))).toBe(0)
    expect(cosine(vec([['a', 1]]), vec([]))).toBe(0)
  })
})

describe('similarities', () => {
  it('ranks the semantically-related doc higher (shared bigrams)', () => {
    const docs = ['如何提交 git 代码', '量子的粒子物理']
    const scores = similarities('提交代码', docs)
    expect(scores[0]!).toBeGreaterThan(scores[1]!)
  })

  it('matches reworded/reordered CJK phrases via bigram overlap', () => {
    const docs = ['发布新版本', '提交代码']
    const scores = similarities('版本发布', docs)
    expect(scores[0]!).toBeGreaterThan(scores[1]!)
  })

  it('returns zero scores when the query shares nothing with any doc', () => {
    const scores = similarities('完全无关', ['aaa bbb ccc'])
    expect(scores[0]).toBe(0)
  })
})

describe('findNearDuplicates', () => {
  it('flags identical docs as a near-duplicate pair (similarity ≈ 1)', () => {
    const pairs = findNearDuplicates(['same text here', 'same text here', 'other topic'], 0.5)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.i).toBe(0)
    expect(pairs[0]!.j).toBe(1)
    expect(pairs[0]!.similarity).toBeCloseTo(1)
  })

  it('returns empty when no pair exceeds the threshold', () => {
    expect(findNearDuplicates(['aaa bbb', 'ccc ddd', 'eee fff'], 0.1)).toHaveLength(0)
  })

  it('sorts pairs by similarity descending', () => {
    const pairs = findNearDuplicates(['alpha beta', 'alpha beta', 'alpha gamma'], 0)
    expect(pairs[0]!.similarity).toBeGreaterThan(pairs[1]!.similarity)
  })
})
