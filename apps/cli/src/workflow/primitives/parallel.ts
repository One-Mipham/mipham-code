import os from 'node:os'

/**
 * parallel() — barrier: executes all thunks concurrently, waits for all.
 * Failed thunks resolve to null. Never throws.
 *
 * P0-2 (v2.1.223 alignment): Added concurrency cap (MAX_CONCURRENT) to prevent
 * resource exhaustion from unbounded fan-out.
 *
 * v2.1.229 alignment: detect parallelism via os.availableParallelism() so
 * CPU-limited containers (cgroup quota) don't fan out to the host core count.
 * Still capped at 16 to bound resource usage, with a floor of 1.
 */
function detectParallelism(): number {
  try {
    if (typeof os.availableParallelism === 'function') {
      const p = os.availableParallelism()
      if (typeof p === 'number' && p > 0) return p
    }
  } catch {
    /* fall through to cpus() */
  }
  return os.cpus().length || 1
}

/**
 * Resolve the concurrency cap for parallel() fan-out. Defaults to CPU-derived
 * parallelism capped at 16. An explicit `MIPHAM_WORKFLOW_MAX_CONCURRENT_AGENTS`
 * (1–256) overrides it, for inference-bound fan-outs whose bottleneck is LLM
 * latency rather than CPU. Invalid / out-of-range values fall back to the default.
 */
export function resolveMaxConcurrent(envValue: string | undefined): number {
  if (envValue !== undefined && envValue !== '') {
    const n = Number(envValue)
    if (Number.isInteger(n) && n >= 1) return Math.min(n, 256)
  }
  return Math.max(1, Math.min(16, detectParallelism()))
}

const MAX_CONCURRENT = resolveMaxConcurrent(process.env.MIPHAM_WORKFLOW_MAX_CONCURRENT_AGENTS)

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
