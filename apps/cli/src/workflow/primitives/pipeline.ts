/**
 * pipeline() — no barrier: each item flows through all stages independently.
 * Item A can be in stage 3 while item B is still in stage 1.
 * Failed items become null and skip remaining stages.
 */
export async function pipeline<T, R>(
  items: T[],
  ...stages: Array<(item: T, index: number, original: T) => Promise<R>>
): Promise<(R | null)[]> {
  // Process each item through all stages concurrently
  return Promise.all(
    items.map(async (item, index) => {
      let current: unknown = item
      for (const stage of stages) {
        try {
          current = await stage(current as T, index, item)
        } catch {
          return null // item failed, skip remaining stages
        }
      }
      return current as R
    }),
  )
}
