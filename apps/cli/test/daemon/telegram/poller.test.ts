import { describe, it, expect } from 'vitest'
import { extractTextMessage, nextOffset, nextBackoff } from '../../../src/daemon/telegram/poller.js'

describe('extractTextMessage', () => {
  it('text 消息 → TelegramMessage', () => {
    const m = extractTextMessage({ message: { chat: { id: 111 }, message_id: 5, text: 'hi' } })
    expect(m).toEqual({ chatId: '111', messageId: 5, text: 'hi' })
  })

  it('非 text / 无 message → null', () => {
    expect(extractTextMessage({ message: { chat: { id: 111 }, message_id: 5 } })).toBeNull()
    expect(extractTextMessage({ update_id: 1 })).toBeNull()
    expect(extractTextMessage({})).toBeNull()
  })

  it('chat.id 字符串化（64 位安全）', () => {
    const m = extractTextMessage({ message: { chat: { id: 999 }, text: 'x' } })
    expect(m!.chatId).toBe('999')
  })
})

describe('nextOffset', () => {
  it('空列表沿用 prev', () => expect(nextOffset([], 5)).toBe(5))
  it('返回最大 update_id + 1', () =>
    expect(nextOffset([{ update_id: 3 }, { update_id: 7 }], 2)).toBe(8))
})

describe('nextBackoff', () => {
  it('指数退避', () => expect(nextBackoff(1000)).toBe(2000))
  it('封顶 30s', () => expect(nextBackoff(20000)).toBe(30000))
})
