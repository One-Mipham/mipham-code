/** APIs disabled in workflow scripts to ensure deterministic replay. */
const FORBIDDEN = new Set(['Date.now', 'Math.random', 'crypto.randomUUID'])

/**
 * Create a sandboxed global scope for workflow script execution.
 * Blocks Date.now(), Math.random(), argless new Date(), crypto.randomUUID().
 */
export function createSandbox(
  args: unknown,
  budget: { total: number | null; spent(): number; remaining(): number },
): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    args,
    budget,
    console: {
      log: (..._a: unknown[]) => {}, // no-op in sandbox
      error: (..._a: unknown[]) => {},
    },
    // Primitives are injected by the runtime, not the sandbox
  }

  // Override Date to block now() and argless constructor
  const OriginalDate = Date
  sandbox.Date = new Proxy(OriginalDate, {
    construct(_target, constructorArgs) {
      if (constructorArgs.length === 0) {
        throw new Error(
          'new Date() is disabled in workflow sandbox. Pass timestamps via args.',
        )
      }
      return new (OriginalDate as unknown as new (...a: unknown[]) => Date)(
        ...(constructorArgs as [number]),
      )
    },
    get(_target, prop) {
      if (prop === 'now') {
        throw new Error(
          'Date.now() is disabled in workflow sandbox. Pass timestamps via args.',
        )
      }
      const val = (OriginalDate as unknown as Record<string, unknown>)[prop as string]
      return typeof val === 'function' ? (val as Function).bind(OriginalDate) : val
    },
  })

  // Override Math.random
  sandbox.Math = new Proxy(Math, {
    get(_target, prop) {
      if (prop === 'random') {
        throw new Error(
          'Math.random() is disabled in workflow sandbox. Use a seed from args.',
        )
      }
      const val = (Math as unknown as Record<string, unknown>)[prop as string]
      return typeof val === 'function' ? (val as Function).bind(Math) : val
    },
  })

  // Block crypto.randomUUID
  const globalCrypto = (globalThis as Record<string, unknown>).crypto as
    | { randomUUID?: unknown; [key: string]: unknown }
    | undefined
  if (globalCrypto) {
    sandbox.crypto = new Proxy(globalCrypto, {
      get(_target, prop) {
        if (prop === 'randomUUID') {
          throw new Error('crypto.randomUUID() is disabled in workflow sandbox.')
        }
        const val = (globalCrypto as Record<string, unknown>)[prop as string]
        return typeof val === 'function'
          ? (val as Function).bind(globalCrypto)
          : val
      },
    })
  }

  return sandbox
}

/** Check whether a given API identifier is in the forbidden set. */
export function isForbidden(id: string): boolean {
  return FORBIDDEN.has(id)
}
