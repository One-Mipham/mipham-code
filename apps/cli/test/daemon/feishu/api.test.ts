import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()
vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 1 },
  Domain: { Feishu: 'feishu' },
  Client: class {
    im: any
    constructor(opts: unknown) {
      createMock(opts)
      this.im = { message: { create: vi.fn() } }
    }
  },
}))

import { createFeishuApi } from '../../../src/daemon/feishu/api.js'

const config = {
  appId: 'app-1',
  appSecret: 'sec-1',
  encryptKey: 'key',
  verificationToken: 'tok',
  allowedOpenIds: [],
}

beforeEach(() => createMock.mockClear())

describe('createFeishuApi.sendText', () => {
  it('构造 Client 并调用 im.message.create', async () => {
    const api = createFeishuApi(config)
    await api.sendText('ou_1', 'hello')
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-1', appSecret: 'sec-1' }),
    )
  })
})
