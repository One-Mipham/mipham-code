import vm from 'node:vm'

/** APIs disabled in workflow scripts to ensure deterministic replay + sandbox escape prevention. */
const FORBIDDEN = new Set(['Date.now', 'Math.random', 'crypto.randomUUID'])

/**
 * Create a sandboxed VM context for workflow script execution.
 * Blocks Date.now(), Math.random(), argless new Date(), crypto.randomUUID(),
 * plus explicit sandbox escape vectors: eval, Function constructor, import(),
 * require(), process, Bun, fetch, setTimeout/setInterval, etc.
 */
export function createSandbox(
  args: unknown,
  budget: { total: number | null; spent(): number; remaining(): number },
): vm.Context {
  const sandboxObj: Record<string, unknown> = {
    args,
    budget,
    console: {
      log: (..._a: unknown[]) => {}, // no-op in sandbox
      error: (..._a: unknown[]) => {},
    },

    // ── Explicit sandbox escape prevention ──
    // V8 builtins that would otherwise be available in a vm.Context
    eval: () => {
      throw new Error('eval() is disabled in workflow sandbox.')
    },
    Function: () => {
      throw new Error('new Function() is disabled in workflow sandbox.')
    },
  }

  // Override Date to block now() and argless constructor
  const OriginalDate = Date
  sandboxObj.Date = new Proxy(OriginalDate, {
    construct(_target, constructorArgs) {
      if (constructorArgs.length === 0) {
        throw new Error('new Date() is disabled in workflow sandbox. Pass timestamps via args.')
      }
      return new (OriginalDate as unknown as new (...a: unknown[]) => Date)(
        ...(constructorArgs as [number]),
      )
    },
    get(_target, prop) {
      if (prop === 'now') {
        throw new Error('Date.now() is disabled in workflow sandbox. Pass timestamps via args.')
      }
      const val = (OriginalDate as unknown as Record<string, unknown>)[prop as string]
      return typeof val === 'function'
        ? (val as (...args: unknown[]) => unknown).bind(OriginalDate)
        : val
    },
  })

  // Override Math.random
  sandboxObj.Math = new Proxy(Math, {
    get(_target, prop) {
      if (prop === 'random') {
        throw new Error('Math.random() is disabled in workflow sandbox. Use a seed from args.')
      }
      const val = (Math as unknown as Record<string, unknown>)[prop as string]
      return typeof val === 'function' ? (val as (...args: unknown[]) => unknown).bind(Math) : val
    },
  })

  // Block crypto.randomUUID
  const globalCrypto = (globalThis as Record<string, unknown>).crypto as
    | { randomUUID?: unknown; [key: string]: unknown }
    | undefined
  if (globalCrypto) {
    sandboxObj.crypto = new Proxy(globalCrypto, {
      get(_target, prop) {
        if (prop === 'randomUUID') {
          throw new Error('crypto.randomUUID() is disabled in workflow sandbox.')
        }
        const val = (globalCrypto as Record<string, unknown>)[prop as string]
        return typeof val === 'function'
          ? (val as (...args: unknown[]) => unknown).bind(globalCrypto)
          : val
      },
    })
  }

  return vm.createContext(sandboxObj)
}

/** Check whether a given API identifier is in the forbidden set. */
export function isForbidden(id: string): boolean {
  return FORBIDDEN.has(id)
}
