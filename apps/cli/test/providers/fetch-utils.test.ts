import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  streamIdleTimeoutMs,
  STREAM_IDLE_TIMEOUT_BASE_MS,
  fetchWithRetry,
  retryDelayMs,
  RETRY_AFTER_MAX_MS,
  isRetryableFailure,
  createAwakeTimer,
} from '../../src/providers/fetch-utils'

describe('streamIdleTimeoutMs', () => {
  it('returns base timeout for unknown/absent effort', () => {
    expect(streamIdleTimeoutMs()).toBe(STREAM_IDLE_TIMEOUT_BASE_MS)
    expect(streamIdleTimeoutMs('low')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS)
    expect(streamIdleTimeoutMs('medium')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS)
    expect(streamIdleTimeoutMs('bogus')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS)
  })

  it('scales by effort: high 2×, xhigh 3×, max 4×', () => {
    expect(streamIdleTimeoutMs('high')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS * 2)
    expect(streamIdleTimeoutMs('xhigh')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS * 3)
    expect(streamIdleTimeoutMs('max')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS * 4)
  })

  it('monotonically increases with effort', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max']
    for (let i = 1; i < levels.length; i++) {
      expect(streamIdleTimeoutMs(levels[i]!)).toBeGreaterThanOrEqual(
        streamIdleTimeoutMs(levels[i - 1]!),
      )
    }
  })
})

describe('retryDelayMs', () => {
  it('falls back to exponential backoff when the header is absent', () => {
    expect(retryDelayMs(null, 0, 1000)).toBe(1000)
    expect(retryDelayMs(null, 1, 1000)).toBe(2000)
    expect(retryDelayMs(null, 2, 1000)).toBe(4000)
  })

  it('caps a long Retry-After instead of sleeping for it', () => {
    // A 5xx answering `Retry-After: 3600` used to sleep the CLI for a full hour.
    expect(retryDelayMs('3600', 0, 1000)).toBe(RETRY_AFTER_MAX_MS)
    expect(retryDelayMs('120', 0, 1000)).toBe(RETRY_AFTER_MAX_MS)
    expect(RETRY_AFTER_MAX_MS).toBeLessThan(3600 * 1000)
  })

  it('honours a Retry-After inside the cap', () => {
    expect(retryDelayMs('5', 0, 1000)).toBe(5000)
  })

  it('floors Retry-After: 0 so retries never go back to back', () => {
    expect(retryDelayMs('0', 0, 1000)).toBeGreaterThan(0)
    // A negative value is nonsense too — same floor.
    expect(retryDelayMs('-5', 0, 1000)).toBeGreaterThan(0)
  })

  it('never turns an unparseable header into a zero or NaN sleep', () => {
    // `NaN * 1000` reaches setTimeout as 0 — an unthrottled retry storm that
    // looks exactly like "no delay configured".
    for (const header of ['soon', 'NaN', '', ' ', 'Retry-After']) {
      const d = retryDelayMs(header, 1, 1000)
      expect(Number.isFinite(d)).toBe(true)
      expect(d).toBeGreaterThan(0)
    }
  })

  it('understands the HTTP-date form, clamped the same way', () => {
    const past = new Date(Date.now() - 60_000).toUTCString()
    expect(retryDelayMs(past, 0, 1000)).toBeGreaterThan(0)

    const far = new Date(Date.now() + 3600_000).toUTCString()
    expect(retryDelayMs(far, 0, 1000)).toBe(RETRY_AFTER_MAX_MS)
  })
})

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries once on first-byte timeout, then throws a clear error', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init.signal!.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchWithRetry(
        'https://example.com/api',
        { method: 'POST' },
        { timeout: 10, maxRetries: 1, baseDelay: 1 },
      ),
    ).rejects.toThrow(/No response from API/)

    expect(fetchMock).toHaveBeenCalledTimes(2) // initial + 1 retry
  })

  it('does not retry on caller abort', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init.signal!.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const caller = new AbortController()
    const p = fetchWithRetry(
      'https://example.com/api',
      { method: 'POST', signal: caller.signal },
      { timeout: 60_000, maxRetries: 3, baseDelay: 1 },
    )
    caller.abort()

    await expect(p).rejects.toThrow(/aborted/i)
    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry on caller cancel
  })

  it('retries the overloaded status (529) on the same terms as a 503', async () => {
    // 529 是 Anthropic 的非标准 overload 信号，请求在流开始**之前**就被拒 ——
    // 与 503 同性质：瞬时、可重试、并且已被 Retry-After 上限封顶。
    // 它不在集合里时，这一响应走 `!response.ok`，整轮在第一个字节就死。
    const fetchMock = vi.fn(async () => new Response('overloaded', { status: 529 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchWithRetry(
      'https://example.com/api',
      { method: 'POST' },
      { maxRetries: 1, baseDelay: 1 },
    )

    expect(fetchMock).toHaveBeenCalledTimes(2) // initial + 1 retry
    expect(res.status).toBe(529) // retries exhausted → the response is handed back
  })

  it('仍不重试 4xx —— 重试集合不是「只要出错就重试」', async () => {
    const fetchMock = vi.fn(async () => new Response('bad request', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchWithRetry(
      'https://example.com/api',
      { method: 'POST' },
      { maxRetries: 3, baseDelay: 1 },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(400)
  })
})

// ============================================================
// `isRetryableFailure` —— 「这次失败值不值得重发」的判据。
//
// 引擎对**任何** error 块原先一律原地重试一次、再跨 provider 回退：内容过滤、
// 401、畸形请求同样被重发 ⇒ 用户为一个**第一次就是最终答案**的错误多等两轮，
// 而且换 provider 也改不了那句话。
//
// 两个调用形状（HTTP 状态 / provider 的错误对象 `type`），判据方向不同：
//   · 状态：与 `fetchWithRetry` 同一把尺（429 与 5xx 是瞬时的）；
//   · 错误类型：只有**已知确定性**的那几个说不 —— 认不出的类型一律保持可重试，
//     猜「最终」会丢掉一次本来能救回来的回合。
// ============================================================

describe('isRetryableFailure', () => {
  it('状态：429 与 5xx 可重试（与 fetchWithRetry 同一把尺）', () => {
    expect(isRetryableFailure(429)).toBe(true)
    expect(isRetryableFailure(500)).toBe(true)
    expect(isRetryableFailure(503)).toBe(true)
    expect(isRetryableFailure(529)).toBe(true)
  })

  it('状态：4xx（除 429）不可重发 —— 重发只会拿到同一句话', () => {
    for (const s of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableFailure(s), `HTTP ${s}`).toBe(false)
    }
  })

  it('错误类型：已知确定性的一律不重发', () => {
    for (const t of [
      'invalid_request_error',
      'authentication_error',
      'permission_error',
      'not_found_error',
      'request_too_large',
      'content_filter',
      'content_policy_violation',
    ]) {
      expect(isRetryableFailure(undefined, t), t).toBe(false)
    }
  })

  it('错误类型：认不出的保持可重试（猜「最终」会丢一次能救回来的回合）', () => {
    expect(isRetryableFailure(undefined, 'overloaded_error')).toBe(true)
    expect(isRetryableFailure(undefined, 'server_error')).toBe(true)
    expect(isRetryableFailure(undefined, 'some_future_type')).toBe(true)
  })

  it('两个都没给 ⇒ 保持可重试（未声明 = 未知，不是「最终」）', () => {
    expect(isRetryableFailure(undefined)).toBe(true)
  })
})

/**
 * `createAwakeTimer` —— 量的是**醒着的时间**，不是壁钟。
 *
 * 为什么值得单独测：笔记本合盖一小时，`setTimeout` 会在唤醒的**那一瞬**把所有到期
 * 定时器一次烧掉，于是 90 秒的流空闲预算在用户掀开屏幕的瞬间被判定「早已超时」，
 * 连接明明一秒钟都没真闲着，回合却被杀掉。所以「定时器到点」与「预算真的用完」
 * 是两件事，这个函数存在的全部理由就是不让它们划等号。
 *
 * 测法：`setTimeout` 走假时钟（确定、不等待），`performance.now` 由这里手控 ——
 * 「宿主机挂起」在代码里的长相，正是**壁钟前进而 `performance.now` 不动**。
 */
describe('createAwakeTimer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** 手控的 `performance.now()`：`awake` 就是「这台机器醒着的时间」。 */
  function withAwakeClock(): { at: () => number; advance: (ms: number) => void } {
    let awake = 0
    vi.spyOn(performance, 'now').mockImplementation(() => awake)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    return {
      at: () => awake,
      advance: (ms) => {
        awake += ms
      },
    }
  }

  it('正对照：正常流逝下用完预算就触发（否则下面「不触发」可能只是它从不触发）', () => {
    const clock = withAwakeClock()
    const onExpire = vi.fn()
    createAwakeTimer(1000, onExpire)

    // 前半段：醒着的时间与壁钟同步前进
    clock.advance(600)
    vi.advanceTimersByTime(600)
    expect(onExpire, '预算还没用完就不该触发').not.toHaveBeenCalled()

    clock.advance(400)
    vi.advanceTimersByTime(400)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('宿主机睡过去导致的提前到点不算超时：重新武装，不触发', () => {
    const clock = withAwakeClock()
    const onExpire = vi.fn()
    createAwakeTimer(1000, onExpire)

    // 合盖一小时：壁钟照跑，performance.now 不动 —— 定时器到点，但一秒都没真等
    vi.advanceTimersByTime(1000)
    expect(onExpire, '睡过去的那一跳不能被当成流卡住了').not.toHaveBeenCalled()

    // 醒来后预算才真正走完
    clock.advance(1000)
    vi.advanceTimersByTime(1000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('重复被睡眠打断也不丢预算：每次都补到剩下的那一份', () => {
    const clock = withAwakeClock()
    const onExpire = vi.fn()
    createAwakeTimer(1000, onExpire)

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1000) // 又睡了：壁钟到点，醒着的时间没动
      clock.advance(300) // 每次醒来后真的干了 300ms 的活
    }
    vi.advanceTimersByTime(1000)
    expect(onExpire, '醒了 900ms，还差 100ms，不该触发').not.toHaveBeenCalled()

    clock.advance(100)
    vi.advanceTimersByTime(100)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('触发之后不再武装 —— 不会每隔一个预算就再响一次', () => {
    const clock = withAwakeClock()
    const onExpire = vi.fn()
    createAwakeTimer(1000, onExpire)

    clock.advance(1000)
    vi.advanceTimersByTime(1000)
    expect(onExpire).toHaveBeenCalledTimes(1)

    clock.advance(10_000)
    vi.advanceTimersByTime(10_000)
    expect(onExpire, '回放器要的是一次超时，不是一串').toHaveBeenCalledTimes(1)
  })

  it('取消之后既不再触发，也不再重新武装', () => {
    const clock = withAwakeClock()
    const onExpire = vi.fn()
    const cancel = createAwakeTimer(1000, onExpire)

    cancel()
    vi.advanceTimersByTime(1000) // 睡过去一跳：本来会走「重新武装」那条路
    clock.advance(10_000)
    vi.advanceTimersByTime(10_000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('对时精确到界：刚好用满预算就触发（`<` 不是 `<=`）', () => {
    const clock = withAwakeClock()
    const onExpire = vi.fn()
    createAwakeTimer(1000, onExpire)

    clock.advance(1000)
    vi.advanceTimersByTime(1000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })
})
