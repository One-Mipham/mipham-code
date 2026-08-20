import { describe, it, expect, vi, afterEach } from 'vitest'
import { createTelegramApi } from '../../../src/daemon/telegram/api.js'

const fetchMock = vi.fn()
afterEach(() => vi.unstubAllGlobals())

function stubFetch(json: unknown, ok = true) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(json), { status: ok ? 200 : 500 }))
  vi.stubGlobal('fetch', fetchMock)
}

describe('createTelegramApi', () => {
  it('getUpdates 构造正确 URL（token/method/offset/timeout）', async () => {
    stubFetch({ ok: true, result: [{ update_id: 7 }] })
    const api = createTelegramApi({ botToken: '123:abc', allowedChatIds: [] })
    await api.getUpdates(5, 30)
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('/bot123:abc/getUpdates')
    expect(url).toContain('offset=5')
    expect(url).toContain('timeout=30')
  })

  it('getUpdates 返回 result 数组', async () => {
    stubFetch({ ok: true, result: [{ update_id: 7 }] })
    const api = createTelegramApi({ botToken: '123:abc', allowedChatIds: [] })
    await expect(api.getUpdates(0, 30)).resolves.toEqual([{ update_id: 7 }])
  })

  it('sendText POST JSON body { chat_id, text }', async () => {
    stubFetch({ ok: true, result: {} })
    const api = createTelegramApi({ botToken: '123:abc', allowedChatIds: [] })
    await api.sendText('111', 'hi')
    const [, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ chat_id: '111', text: 'hi' })
  })

  it('非 ok 响应 → 抛错', async () => {
    stubFetch({ ok: false, description: 'Unauthorized' }, false)
    const api = createTelegramApi({ botToken: '123:abc', allowedChatIds: [] })
    await expect(api.getUpdates(0, 30)).rejects.toThrow()
  })
})
