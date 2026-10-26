import { describe, it, expect, afterEach } from 'vitest'
import { internalGitEnv } from '../../src/shared/git-env'

describe('internalGitEnv', () => {
  const original = process.env.GIT_NO_REPLACE_OBJECTS

  afterEach(() => {
    if (original === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS
    else process.env.GIT_NO_REPLACE_OBJECTS = original
  })

  it('屏蔽 replace refs', () => {
    expect(internalGitEnv().GIT_NO_REPLACE_OBJECTS).toBe('1')
  })

  it('带上传入的环境（PATH / HOME 等缺了 git 自己也跑不起来）', () => {
    process.env.MIPHAM_GIT_ENV_PROBE = 'kept'
    try {
      expect(internalGitEnv().MIPHAM_GIT_ENV_PROBE).toBe('kept')
      expect(internalGitEnv().PATH).toBe(process.env.PATH)
    } finally {
      delete process.env.MIPHAM_GIT_ENV_PROBE
    }
  })

  it('返回的是副本：改它不会污染 process.env', () => {
    const env = internalGitEnv()
    env.GIT_NO_REPLACE_OBJECTS = 'tampered'
    expect(process.env.GIT_NO_REPLACE_OBJECTS).toBe(original)
  })

  it('调用方本来就把变量设成别的值时以调用方的为准？（不：本函数是内部 git 的固定口径）', () => {
    // `GIT_NO_REPLACE_OBJECTS=0` 是 git 里「没设」的意思 —— 若照抄用户环境，
    // 「用户在 shell 里导出过 0」这一个无关操作就会悄悄关掉隔离边界。
    process.env.GIT_NO_REPLACE_OBJECTS = '0'
    expect(internalGitEnv().GIT_NO_REPLACE_OBJECTS).toBe('1')
  })
})
