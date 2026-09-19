import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkForUpdatesAsync } from '../../src/shared/update'
import { PACKAGE_VERSION } from '../../src/shared/package-info'

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockFetchResponse(version: string) {
  return { ok: true, json: async () => ({ version }) }
}

describe('checkForUpdatesAsync', () => {
  it('有新版 → available: true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockFetchResponse('9.9.9')),
    )
    const r = await checkForUpdatesAsync()
    expect(r.available).toBe(true)
    expect(r.latest).toBe('9.9.9')
    expect(r.checked).toBe(true)
  })

  it('同版本 → available: false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockFetchResponse(PACKAGE_VERSION)),
    )
    const r = await checkForUpdatesAsync()
    expect(r.available).toBe(false)
    expect(r.checked).toBe(true) // 「问过了」与「没问成」必须分得开
  })

  it('离线/失败 → available: false 且 checked: false（兜底不惊扰，但不冒充答案）', async () => {
    // `checked` 是这条缺陷的判据：没有它，`available: false` 既表示「查过、是最新」
    // 也表示「没查成」，`/upgrade` 于是对后者印了前者。
    // 负控：把 `checked = true` 的赋值挪进 catch，或删掉 catch 里的初值，本断言即红。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const r = await checkForUpdatesAsync()
    expect(r.available).toBe(false)
    expect(r.checked).toBe(false)
  })

  it('npm 失败 → npmmirror 回退', async () => {
    const mock = vi.fn(async (url: string) => {
      if (url.includes('registry.npmjs.org')) throw new Error('npm down')
      return mockFetchResponse('9.9.9')
    })
    vi.stubGlobal('fetch', mock)
    const r = await checkForUpdatesAsync()
    expect(r.available).toBe(true)
    expect(r.latest).toBe('9.9.9')
    expect(r.checked).toBe(true)
    expect(mock).toHaveBeenCalledTimes(2)
  })
})
