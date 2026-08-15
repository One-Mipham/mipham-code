import vm from 'node:vm'

/** APIs disabled in workflow scripts to ensure deterministic replay + sandbox escape prevention. */
const FORBIDDEN = new Set(['Date.now', 'Math.random', 'crypto.randomUUID'])

/**
 * Wrap a host function so `.constructor` / `.prototype` / `__proto__` access
 * cannot reach the host `Function` constructor (blocks
 * `fn.constructor('return process')()` and friends).
 */
function sealFunction<T extends (...args: never[]) => unknown>(fn: T): T {
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'constructor' || prop === 'prototype' || prop === '__proto__') {
        return undefined
      }
      return Reflect.get(target, prop)
    },
    apply(target, thisArg, argArray) {
      return Reflect.apply(target, thisArg, argArray)
    },
  }) as T
}

/**
 * Best-effort seal a value: freeze objects and wrap function properties so
 * their constructor chain can't reach host globals.
 */
export function sealValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return value
  if (typeof value === 'function') {
    return sealFunction(value as (...args: never[]) => unknown)
  }
  if (value && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      const child = (value as Record<string, unknown>)[key]
      if (typeof child === 'function') {
        ;(value as Record<string, unknown>)[key] = sealFunction(
          child as (...args: never[]) => unknown,
        )
      }
    }
    return Object.freeze(value)
  }
  return value
}

/**
 * Create a VM context for workflow script execution.
 *
 * SECURITY: node:vm is NOT a security boundary. Workflow scripts are
 * model-authored code running in the same process — the model already has
 * Bash access, so this context does NOT isolate the script from the host.
 * Its purpose is determinism (blocking Date.now/Math.random/randomUUID for
 * reproducible replay) plus best-effort blocking of common escape vectors.
 * Do not treat this as a sandbox that can safely run untrusted code.
 */
export function createSandbox(
  args: unknown,
  budget: { total: number | null; spent(): number; remaining(): number },
): vm.Context {
  const sandboxObj: Record<string, unknown> = {
    args: sealValue(args),
    budget: sealValue(budget),
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
