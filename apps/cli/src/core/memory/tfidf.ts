// Local TF-IDF similarity — zero-dependency "semantic-ish" recall.
//
// The built-in memory is local files and must stay offline. This module upgrades
// the old exact-keyword overlap to TF-IDF-weighted cosine similarity, with a CJK
// character-bigram tokenizer so Chinese content (which has no word separators)
// is matched on adjacent-character overlap rather than whole-word equality.

const CJK_RE = /[㐀-䶿一-鿿]/
const WORD_RE = /[a-z0-9]/

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch)
}

function isWordChar(ch: string): boolean {
  return WORD_RE.test(ch)
}

/**
 * Tokenize text into CJK character bigrams + lowercase ASCII words (length ≥ 2).
 * Punctuation and single-char ASCII tokens are dropped as noise.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  let i = 0

  while (i < lower.length) {
    const ch = lower[i]!
    if (isCjk(ch)) {
      let run = ''
      while (i < lower.length && isCjk(lower[i]!)) {
        run += lower[i]!
        i++
      }
      if (run.length === 1) {
        tokens.push(run)
      } else {
        for (let j = 0; j < run.length - 1; j++) {
          tokens.push(run.slice(j, j + 2))
        }
      }
    } else if (isWordChar(ch)) {
      let word = ''
      while (i < lower.length && isWordChar(lower[i]!)) {
        word += lower[i]!
        i++
      }
      if (word.length >= 2) tokens.push(word)
    } else {
      i++
    }
  }

  return tokens
}

/** Cosine similarity between two sparse term-weight vectors. */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let normA = 0
  for (const [term, w] of a) {
    normA += w * w
    const wb = b.get(term)
    if (wb !== undefined) dot += w * wb
  }
  let normB = 0
  for (const w of b.values()) normB += w * w
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** TF-IDF weight vector for one token list, given corpus document frequency. */
function tfidfVector(
  tokens: string[],
  df: Map<string, number>,
  numDocs: number,
): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)

  const vec = new Map<string, number>()
  for (const [term, freq] of tf) {
    const idf = Math.log((numDocs + 1) / ((df.get(term) ?? 0) + 1)) + 1
    vec.set(term, freq * idf)
  }
  return vec
}

/**
 * Cosine similarity of a query against each document, index-aligned.
 * `docs` are raw texts; tokenization + TF-IDF weighting is applied internally.
 */
export function similarities(query: string, docs: string[]): number[] {
  const docTokens = docs.map(tokenize)
  const queryTokens = tokenize(query)
  const numDocs = docs.length

  const df = new Map<string, number>()
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }

  const queryVec = tfidfVector(queryTokens, df, numDocs)
  return docTokens.map((tokens) => cosine(queryVec, tfidfVector(tokens, df, numDocs)))
}

/**
 * All pairs (i < j) of docs whose TF-IDF cosine similarity is `> threshold`,
 * sorted by similarity descending. Deterministic near-duplicate detection —
 * flags candidates for manual merge, never merges automatically.
 */
export function findNearDuplicates(
  docs: string[],
  threshold: number,
): Array<{ i: number; j: number; similarity: number }> {
  const docTokens = docs.map(tokenize)
  const numDocs = docs.length

  const df = new Map<string, number>()
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }

  const vectors = docTokens.map((tokens) => tfidfVector(tokens, df, numDocs))
  const pairs: Array<{ i: number; j: number; similarity: number }> = []
  for (let i = 0; i < numDocs; i++) {
    for (let j = i + 1; j < numDocs; j++) {
      const similarity = cosine(vectors[i]!, vectors[j]!)
      if (similarity > threshold) pairs.push({ i, j, similarity })
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity)
}
