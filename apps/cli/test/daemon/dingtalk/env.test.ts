import { describe, it, expect, afterEach } from 'vitest'
import { parseDingtalkEnv } from '../../../src/daemon/dingtalk/env.js'

afterEach(() => {
  delete process.env.DINGTALK_CLIENT_ID
  delete process.env.DINGTALK_CLIENT_SECRET
  delete process.env.DINGTALK_ALLOWED_STAFF_IDS
})

describe('parseDingtalkEnv', () => {
  it('缺 clientId → null（fail-closed）', () => {
    process.env.DINGTALK_CLIENT_SECRET = 'secret'
    expect(parseDingtalkEnv()).toBeNull()
  })

  it('缺 clientSecret → null（fail-closed）', () => {
    process.env.DINGTALK_CLIENT_ID = 'id'
    expect(parseDingtalkEnv()).toBeNull()
  })

  it('两者齐全无白名单 → 空数组', () => {
    process.env.DINGTALK_CLIENT_ID = 'id'
    process.env.DINGTALK_CLIENT_SECRET = 'secret'
    expect(parseDingtalkEnv()).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
      allowedStaffIds: [],
    })
  })

  it('白名单逗号分隔 trim + 过滤空项', () => {
    process.env.DINGTALK_CLIENT_ID = 'id'
    process.env.DINGTALK_CLIENT_SECRET = 'secret'
    process.env.DINGTALK_ALLOWED_STAFF_IDS = ' s1 , s2 ,,  '
    expect(parseDingtalkEnv()!.allowedStaffIds).toEqual(['s1', 's2'])
  })
})
