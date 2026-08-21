import { describe, it, expect, afterEach } from 'vitest'
import { parseWecomEnv } from '../../../src/daemon/wecom/env.js'

afterEach(() => {
  delete process.env.WECOM_BOT_ID
  delete process.env.WECOM_BOT_SECRET
  delete process.env.WECOM_ALLOWED_USER_IDS
})

describe('parseWecomEnv', () => {
  it('缺 botId → null（fail-closed）', () => {
    process.env.WECOM_BOT_SECRET = 's'
    expect(parseWecomEnv()).toBeNull()
  })

  it('缺 botSecret → null（fail-closed）', () => {
    process.env.WECOM_BOT_ID = 'b'
    expect(parseWecomEnv()).toBeNull()
  })

  it('有 botId+botSecret 无白名单 → 空数组', () => {
    process.env.WECOM_BOT_ID = 'b'
    process.env.WECOM_BOT_SECRET = 's'
    expect(parseWecomEnv()).toEqual({ botId: 'b', botSecret: 's', allowedUserIds: [] })
  })

  it('白名单逗号分隔 trim + 过滤空项', () => {
    process.env.WECOM_BOT_ID = 'b'
    process.env.WECOM_BOT_SECRET = 's'
    process.env.WECOM_ALLOWED_USER_IDS = ' alice , bob ,,  '
    expect(parseWecomEnv()!.allowedUserIds).toEqual(['alice', 'bob'])
  })
})
