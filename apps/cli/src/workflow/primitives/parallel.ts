/**
 * parallel() — barrier: executes all thunks concurrently, waits for all.
 * Failed thunks resolve to null. Never throws.
 */
export async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<(T | null)[]> {
  const results = await Promise.allSettled(thunks.map((t) => t()))
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null))
}
