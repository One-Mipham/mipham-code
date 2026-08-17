import { describe, it, expect, vi, beforeEach } from 'vitest'

const registered: Record<string, (data: any) => unknown> = {}
const invokeMock = vi.fn(async (_assigned: unknown): Promise<unknown> => ({ code: 0 }))
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
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue({ code: 0 })
  })

  it('注册 im.message.receive_v1 处理器并解析文本', async () => {
    const onMessage = vi.fn(async () => {})
    createFeishuEventDispatcher(config, onMessage)

    const handler = registered['im.message.receive_v1']!
    expect(handler).toBeDefined()
    const ret = await handler({
      message: {
        chat_id: 'c1',
        message_id: 'm1',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    })

    expect(ret).toBe(true)
    expect(onMessage).toHaveBeenCalledWith({
      chatId: 'c1',
      messageId: 'm1',
      openId: 'ou_1',
      text: 'hi',
    })
  })

  it('invoke 透传 body + headers 给 SDK，并返回结构化 ok', async () => {
    const onMessage = vi.fn(async () => {})
    const d = createFeishuEventDispatcher(config, onMessage)
    const body = { encrypt: 'x' }
    const headers = { 'x-lark-signature': 'sig' }
    const result = await d.invoke(body, headers)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    const assigned = invokeMock.mock.calls[0]?.[0]
    expect(assigned).toBeDefined()
    const assignedObj = assigned as { headers?: Record<string, string> }
    expect(assignedObj.headers).toEqual(headers)
    expect(Object.prototype.hasOwnProperty.call(assignedObj, 'headers')).toBe(false)
    expect(JSON.stringify(assignedObj)).not.toContain('x-lark-signature')
    expect(result).toEqual({ ok: true })
  })

  it('verify 失败（SDK 返回 undefined）→ invalid_signature', async () => {
    invokeMock.mockResolvedValue(undefined)
    const d = createFeishuEventDispatcher(
      config,
      vi.fn(async () => {}),
    )
    await expect(d.invoke({}, {})).resolves.toEqual({ ok: false, reason: 'invalid_signature' })
  })

  it('无 handler（SDK 返回 "no X event handle"）→ no_handler', async () => {
    invokeMock.mockResolvedValue('no im.message.receive_v1 event handle')
    const d = createFeishuEventDispatcher(
      config,
      vi.fn(async () => {}),
    )
    await expect(d.invoke({}, {})).resolves.toEqual({ ok: false, reason: 'no_handler' })
  })

  it('SDK invoke 抛错 → parse_failed', async () => {
    invokeMock.mockRejectedValue(new Error('boom'))
    const d = createFeishuEventDispatcher(
      config,
      vi.fn(async () => {}),
    )
    await expect(d.invoke({}, {})).resolves.toEqual({ ok: false, reason: 'parse_failed' })
  })
})
