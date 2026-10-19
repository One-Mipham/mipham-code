import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  exitSession,
  registerExitHandler,
  resetExitHandler,
  withTimeout,
  SESSION_END_HOOK_TIMEOUT_MS,
} from '../../src/core/session-exit'

describe('core/session-exit', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetExitHandler()
    // process.exit() never returns in production; stubbing it lets the rest of
    // the module's promise chain run so we can observe ordering.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    resetExitHandler()
    vi.useRealTimers()
  })

  describe('exitSession', () => {
    it('runs the shutdown handler before exiting', async () => {
      const order: string[] = []
      registerExitHandler(async () => {
        await Promise.resolve()
        order.push('handler')
      })

      void exitSession(0)
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))

      expect(order).toEqual(['handler'])
    })

    // A signal can arrive while `/exit` is already shutting down. Running the
    // handler twice would write the session twice and fire SessionEnd hooks
    // twice.
    it('runs the handler once across repeated exits', async () => {
      const handler = vi.fn()
      registerExitHandler(handler)

      void exitSession(0)
      void exitSession(0)
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('still exits when the handler throws', async () => {
      registerExitHandler(() => {
        throw new Error('hook failed')
      })

      void exitSession(0)
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))
    })

    it('still exits when the handler rejects', async () => {
      registerExitHandler(() => Promise.reject(new Error('hook failed')))

      void exitSession(0)
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))
    })

    it('exits when no handler is registered', async () => {
      void exitSession(3)
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(3))
    })

    it('does not run a reset handler', async () => {
      const handler = vi.fn()
      registerExitHandler(handler)
      resetExitHandler()

      void exitSession(0)
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('withTimeout', () => {
    it('returns the value when the promise settles in time', async () => {
      await expect(withTimeout(Promise.resolve('done'), 100)).resolves.toBe('done')
    })

    it('resolves undefined once the budget is spent', async () => {
      vi.useFakeTimers()
      const never = new Promise<string>(() => {})
      const result = withTimeout(never, SESSION_END_HOOK_TIMEOUT_MS)

      await vi.advanceTimersByTimeAsync(SESSION_END_HOOK_TIMEOUT_MS - 1)
      const pending = await Promise.race([result, Promise.resolve('still-waiting')])
      expect(pending).toBe('still-waiting')

      await vi.advanceTimersByTimeAsync(1)
      await expect(result).resolves.toBeUndefined()
    })

    it('does not wait for a rejection to time out', async () => {
      await expect(withTimeout(Promise.reject(new Error('boom')), 10_000)).rejects.toThrow('boom')
    })
  })
})
