import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * `/security` 的秘密扫描：**「没找到」不许与「没查成」同形**。
 *
 * 原来是 `execSync('grep … || echo ""')` 外加一个 `catch { ok.push('No hardcoded
 * secrets detected (quick scan)') }`。于是没装 grep、正则写错、扫到一半超时，
 * 全都渲染成 ✅「No hardcoded secrets detected」—— 一次失败的扫描看起来是一次干净的
 * 扫描。改成 argv 调用后退出码可判：1 = 无匹配（干净）、2+ = 出错（没查）、
 * 没有退出码 = 没跑起来（超时/被杀），后两者必须进 findings。
 */

const h = vi.hoisted(() => ({ execFileSync: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: h.execFileSync,
}))

const { securityCmd } = await import('../../src/commands/project')

const run = async () => {
  const res = await securityCmd({} as Parameters<typeof securityCmd>[0], [])
  return res.content as string
}

/** grep 的「无匹配」：子进程以 1 退出。 */
const noMatch = () => Object.assign(new Error('Command failed: grep'), { status: 1 })
/** grep 出错（正则非法、目录不可读…）：以 2 退出。 */
const grepError = () => Object.assign(new Error('Command failed: grep'), { status: 2 })
/** 根本没跑起来：超时被杀 ⇒ 没有 status。 */
const killed = () =>
  Object.assign(new Error('Command timed out'), { status: null, signal: 'SIGTERM' })

beforeEach(() => {
  h.execFileSync.mockReset()
})

describe('/security 秘密扫描', () => {
  it('grep 退出 1（无匹配）⇒ 才算干净', async () => {
    h.execFileSync.mockImplementation(() => {
      throw noMatch()
    })
    const out = await run()
    expect(out).toContain('No hardcoded secrets detected')
    expect(out).not.toContain('Could not scan')
  })

  it('grep 退出 2（出错）⇒ 报「没查成」，不许说干净', async () => {
    h.execFileSync.mockImplementation(() => {
      throw grepError()
    })
    const out = await run()
    expect(out).toContain('Could not scan for hardcoded secrets')
    expect(out).toContain('**not** a clean result')
    expect(out).not.toContain('No hardcoded secrets detected')
  })

  it('超时/被杀（无退出码）⇒ 同样报「没查成」', async () => {
    h.execFileSync.mockImplementation(() => {
      throw killed()
    })
    const out = await run()
    expect(out).toContain('Could not scan for hardcoded secrets')
    expect(out).not.toContain('No hardcoded secrets detected')
  })

  it('命中 ⇒ 只报 file:line，值打码', async () => {
    h.execFileSync.mockImplementation(
      () =>
        '/tmp/p/a.ts:12:const TOKEN = "abcdef123456"\n/tmp/p/node_modules/x.js:1:TOKEN = "noise"\n',
    )
    const out = await run()
    expect(out).toContain('Hardcoded secrets detected')
    expect(out).toContain('/tmp/p/a.ts:12 [VALUE REDACTED]')
    expect(out).not.toContain('abcdef123456')
    // `.gitignore` 那条建议里也含「node_modules」字样，故只钉那一行命中。
    expect(out).not.toContain('node_modules/x.js')
  })

  it('调用形状是 argv（string, string[]），cwd 作为独立实参而不是拼进 shell 串', async () => {
    h.execFileSync.mockImplementation(() => {
      throw noMatch()
    })
    await run()
    const call = h.execFileSync.mock.calls[0]!
    expect(call[0]).toBe('grep')
    expect(Array.isArray(call[1])).toBe(true)
    const argv = call[1] as string[]
    expect(argv.at(-1)).toBe(process.cwd())
    expect(argv.some((a) => a.includes('--include=*.ts'))).toBe(true)
  })
})
