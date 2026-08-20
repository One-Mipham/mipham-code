import { describe, it, expect, afterEach } from 'vitest'
import { parseTelegramEnv } from '../../../src/daemon/telegram/env.js'

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_ALLOWED_CHAT_IDS
})

describe('parseTelegramEnv', () => {
  it('缺 botToken → null（fail-closed）', () => {
    expect(parseTelegramEnv()).toBeNull()
  })

  it('有 botToken 无白名单 → 空数组', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc'
    expect(parseTelegramEnv()).toEqual({ botToken: '123:abc', allowedChatIds: [] })
  })

  it('白名单逗号分隔 trim + 过滤空项', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc'
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = ' 111 , 222 ,,  '
    expect(parseTelegramEnv()!.allowedChatIds).toEqual(['111', '222'])
  })
})
