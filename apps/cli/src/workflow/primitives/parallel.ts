/**
 * parallel() — barrier: executes all thunks concurrently, waits for all.
 * Failed thunks resolve to null. Never throws.
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

export async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> {
  if (thunks.length === 0) return []

  const semaphore = new Semaphore(MAX_CONCURRENT)
  const results: (T | null)[] = new Array(thunks.length)

  await Promise.all(
    thunks.map(async (thunk, index) => {
      await semaphore.acquire()
      try {
        results[index] = await thunk()
      } catch {
        results[index] = null
      } finally {
        semaphore.release()
      }
    }),
  )

  return results
}
