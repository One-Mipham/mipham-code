export interface Budget {
  total: number | null
  spent(): number
  remaining(): number
  consume(tokens: number): void
}

/**
 * Create a token budget tracker.
 * If totalTokens is null, the budget is unlimited.
 */
export function createBudget(totalTokens: number | null): Budget {
  let spent = 0

  return {
    total: totalTokens,

    spent(): number {
      return spent
    },

    remaining(): number {
      return totalTokens === null ? Infinity : Math.max(0, totalTokens - spent)
    },

    consume(tokens: number): void {
      spent += tokens
      if (totalTokens !== null && spent >= totalTokens) {
        throw new Error('Token budget exceeded')
      }
    },
  }
}
