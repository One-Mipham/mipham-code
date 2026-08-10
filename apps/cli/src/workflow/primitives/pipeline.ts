/**
 * pipeline() — no barrier: each item flows through all stages independently.
 * Item A can be in stage 3 while item B is still in stage 1.
 * Failed items become null and skip remaining stages.
 *
 * P0-2 (v2.1.223 alignment): Added concurrency cap (MAX_CONCURRENT = 16)
 * to prevent resource exhaustion from unbounded fan-out.
 */
const MAX_CONCURRENT = 16

/**
 * Simple async semaphore for concurrency limiting.
 */
class Semaphore {
  private permits: number
  private queue: Array<() => void> = []

  constructor(count: number) {
    this.permits = count
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    } else {
      this.permits++
    }
  }
}

export async function pipeline<T, R>(
  items: T[],
  ...stages: Array<(item: T, index: number, original: T) => Promise<R>>
): Promise<(R | null)[]> {
  if (items.length === 0) return []

  const semaphore = new Semaphore(MAX_CONCURRENT)
  const results: (R | null)[] = new Array(items.length)

  // Process each item through all stages concurrently, with concurrency cap
  await Promise.all(
    items.map(async (item, index) => {
      await semaphore.acquire()
      try {
        let current: unknown = item
        for (const stage of stages) {
          try {
            current = await stage(current as T, index, item)
          } catch {
            results[index] = null
            return // item failed, skip remaining stages
          }
        }
        results[index] = current as R
      } finally {
        semaphore.release()
      }
    }),
  )

  return results
}
