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
  })

  it('同版本 → available: false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mockFetchResponse(PACKAGE_VERSION)),
    )
    const r = await checkForUpdatesAsync()
    expect(r.available).toBe(false)
  })

  it('离线/失败 → available: false（兜底不惊扰）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const r = await checkForUpdatesAsync()
    expect(r.available).toBe(false)
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
    expect(mock).toHaveBeenCalledTimes(2)
  })
})
