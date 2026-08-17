import { describe, it, expect, vi } from 'vitest'

const registered: Record<string, (data: any) => unknown> = {}
const invokeMock = vi.fn(async (_assigned: unknown) => ({ code: 0 }))
vi.mock('@larksuiteoapi/node-sdk', () => ({
  EventDispatcher: class {
    constructor(_opts: unknown) {}
    register(map: Record<string, (data: any) => unknown>) {
      Object.assign(registered, map)
      return this
    }
    async invoke(_assigned: unknown) {
      return invokeMock(_assigned)
    }
  },
}))

import { createFeishuEventDispatcher } from '../../../src/daemon/feishu/events.js'

const config = {
  appId: 'a',
  appSecret: 's',
  encryptKey: 'k',
  verificationToken: 't',
  allowedOpenIds: [],
}

describe('createFeishuEventDispatcher', () => {
  it('注册 im.message.receive_v1 处理器并解析文本', async () => {
    const onMessage = vi.fn(async () => {})
    createFeishuEventDispatcher(config, onMessage)

    const handler = registered['im.message.receive_v1']!
    expect(handler).toBeDefined()
    await handler({
      message: {
        chat_id: 'c1',
        message_id: 'm1',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    })

    expect(onMessage).toHaveBeenCalledWith({
      chatId: 'c1',
      messageId: 'm1',
      openId: 'ou_1',
      text: 'hi',
    })
  })

  it('invoke 透传 body + headers 给 SDK', async () => {
    const onMessage = vi.fn(async () => {})
    const d = createFeishuEventDispatcher(config, onMessage)
    const body = { encrypt: 'x' }
    const headers = { 'x-lark-signature': 'sig' }
    await d.invoke(body, headers)
    expect(invokeMock).toHaveBeenCalled()
  })
})
