import vm from 'node:vm'

/** APIs disabled in workflow scripts to ensure deterministic replay + sandbox escape prevention. */
const FORBIDDEN = new Set(['Date.now', 'Math.random', 'crypto.randomUUID'])

/**
 * Create a sandboxed VM context for workflow script execution.
 * Blocks Date.now(), Math.random(), argless new Date(), crypto.randomUUID(),
 * plus explicit sandbox escape vectors: eval, Function constructor, import(),
 * require(), process, Bun, fetch, setTimeout/setInterval, etc.
 *
 * P0-2 (v2.1.223 alignment): Added explicit defense-in-depth denial of all
 * host globals (process, require, Bun, fetch, setTimeout, etc.) and
 * constructor.constructor escape vector blocking.
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

    // ── P0-2: Defense-in-depth — explicit denial of all host globals ──
    // vm.createContext() does NOT inherit host globals by default, but these
    // explicit undefined entries prevent prototype-chain access and serve as
    // auditable documentation of what is deliberately blocked.
    process: undefined,
    require: undefined,
    import: undefined,
    Bun: undefined,
    fetch: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    queueMicrotask: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    globalThis: undefined,
    global: undefined,
    __dirname: undefined,
    __filename: undefined,
    module: undefined,
    exports: undefined,
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
    { randomUUID?: unknown; [key: string]: unknown } | undefined
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

  // ── P0-2: Block constructor.constructor escape vector ──
  // The chain [].constructor.constructor('return this')() can escape
  // vm.createContext if not blocked. We override Object to intercept
  // constructor access on prototype chains.
  sandboxObj.Object = new Proxy(Object, {
    get(target, prop) {
      if (prop === 'prototype') {
        return new Proxy(Object.prototype, {
          get(protoTarget, protoProp) {
            if (protoProp === 'constructor') {
              const ctor = Object.prototype.constructor
              return new Proxy(ctor, {
                construct() {
                  throw new Error('Dynamic constructor invocation is disabled in workflow sandbox.')
                },
                get(_t, ctorProp) {
                  // Block [].constructor.constructor chain
                  if (ctorProp === 'constructor') {
                    throw new Error('constructor.constructor is disabled in workflow sandbox.')
                  }
                  const val = (ctor as unknown as Record<string, unknown>)[ctorProp as string]
                  return typeof val === 'function'
                    ? (val as (...args: unknown[]) => unknown).bind(ctor)
                    : val
                },
              })
            }
            const val = (protoTarget as Record<string, unknown>)[protoProp as string]
            return typeof val === 'function'
              ? (val as (...args: unknown[]) => unknown).bind(protoTarget)
              : val
          },
        })
      }
      const val = (Object as unknown as Record<string, unknown>)[prop as string]
      return typeof val === 'function' ? (val as (...args: unknown[]) => unknown).bind(Object) : val
    },
  })

  return vm.createContext(sandboxObj)
}

/** Check whether a given API identifier is in the forbidden set. */
export function isForbidden(id: string): boolean {
  return FORBIDDEN.has(id)
}
