import { describe, it, expect, afterEach, vi } from 'vitest'
import { parseFeishuEnv } from '../../../src/daemon/feishu/env.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('parseFeishuEnv', () => {
  it('解析合法 env', () => {
    vi.stubEnv('FEISHU_APP_ID', 'a')
    vi.stubEnv('FEISHU_APP_SECRET', 's')
    vi.stubEnv('FEISHU_ENCRYPT_KEY', 'k')
    vi.stubEnv('FEISHU_VERIFICATION_TOKEN', 't')
    vi.stubEnv('FEISHU_ALLOWED_OPEN_IDS', 'ou_1,ou_2')
    const cfg = parseFeishuEnv()
    expect(cfg?.appId).toBe('a')
    expect(cfg?.appSecret).toBe('s')
    expect(cfg?.encryptKey).toBe('k')
    expect(cfg?.verificationToken).toBe('t')
    expect(cfg?.allowedOpenIds).toEqual(['ou_1', 'ou_2'])
  })

  it('缺 appId 时返回 null', () => {
    vi.stubEnv('FEISHU_APP_ID', '')
    vi.stubEnv('FEISHU_APP_SECRET', 's')
    expect(parseFeishuEnv()).toBeNull()
  })

  it('缺 appSecret 时返回 null', () => {
    vi.stubEnv('FEISHU_APP_ID', 'a')
    vi.stubEnv('FEISHU_APP_SECRET', '')
    expect(parseFeishuEnv()).toBeNull()
  })

  it('allowedOpenIds 过滤空白项', () => {
    vi.stubEnv('FEISHU_APP_ID', 'a')
    vi.stubEnv('FEISHU_APP_SECRET', 's')
    vi.stubEnv('FEISHU_ALLOWED_OPEN_IDS', ' ou_1 , , ou_2 ,')
    expect(parseFeishuEnv()?.allowedOpenIds).toEqual(['ou_1', 'ou_2'])
  })
})
