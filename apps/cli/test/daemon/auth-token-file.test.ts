/**
 * daemon token 的读取：**类型闸**（非普通文件点名报错，不是干等）+ **权限修复**
 * （漂开的 0644 收回 0600，并说一声）。
 *
 * 为什么要跑**子进程**：修前的 `readFileSync` 读一个没有写者的 FIFO 会**同步**阻塞到底 ——
 * 定时器与 signal handler 都排不上队。在进程内测这一格，回归发生时整个 worker 一起僵住，
 * 套件不会红、只是不动。所以那几条一律 `spawnSync` + 硬超时，真回归的读数就是
 * `signal=SIGTERM`，是一条**能红**的断言。
 *
 * 判据取「子进程真的跑完并印出标记」而不是「没超时」—— 后者在子进程压根没起来
 * （`bun` 不在 PATH、脚本有语法错）时同样为真，那是假绿。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateToken, listTokens } from '../../src/daemon/auth'

const CLI_DIR = join(import.meta.dirname, '..', '..')
/** 实测子进程冷启动 ≈ 40ms（探针）/ ≈ 300ms（整条 CLI）；15s 是「几乎不可能到」的上限。 */
const WATCHDOG_MS = 15_000
/** 看门狗自己也占时间，用例超时必须比它宽 —— 否则报的是 vitest 超时，不是我们的读数。 */
const PROBE_TEST_TIMEOUT = 30_000

const abs = (rel: string): string => JSON.stringify(join(CLI_DIR, rel))

type ProbeMode = 'load' | 'list'

const PROBE_SOURCES: Record<ProbeMode, string> = {
  load: `
import { loadOrCreateToken } from ${abs('src/daemon/auth.ts')}
console.log('RESULT calling')
try {
  console.log('RESULT value=' + JSON.stringify(loadOrCreateToken(process.argv[2])))
} catch (err) {
  const m = String(err && err.message)
  console.log('RESULT threw=' + (m.includes('not a regular file') ? 'named' : 'other:' + m.split('\\n')[0]))
}
console.log('RESULT done')
`,
  list: `
import { listTokens } from ${abs('src/daemon/auth.ts')}
console.log('RESULT calling')
try {
  console.log('RESULT list=' + JSON.stringify(listTokens(process.argv[2])))
} catch (err) {
  const m = String(err && err.message)
  console.log('RESULT threw=' + (m.includes('not a regular file') ? 'named' : 'other:' + m.split('\\n')[0]))
}
console.log('RESULT done')
`,
}

interface ProbeRun {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error?: Error
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mipham-token-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeHome(): string {
  const home = mkdtempSync(join(dir, 'home-'))
  mkdirSync(join(home, '.mipham'), { recursive: true })
  return home
}

function mkfifo(path: string): void {
  execFileSync('mkfifo', [path])
}

function modeOf(path: string): string {
  return (statSync(path).mode & 0o777).toString(8)
}

/** 子进程自成一档环境：HOME 指向夹具目录，MIPHAM_* 一律剥掉免得串味。 */
function probeEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  for (const key of Object.keys(env)) {
    if (key.startsWith('MIPHAM_')) delete env[key]
  }
  return env
}

function runProbe(mode: ProbeMode, home: string, arg: string): ProbeRun {
  const script = join(dir, `probe-${mode}.ts`)
  writeFileSync(script, PROBE_SOURCES[mode])
  const r = spawnSync('bun', [script, arg], {
    cwd: dir,
    env: probeEnv(home),
    encoding: 'utf-8',
    timeout: WATCHDOG_MS,
    killSignal: 'SIGTERM',
  })
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
  }
}

/** 「跑完了」= 子进程起来了 + 没被看门狗杀掉 + 印出了标记。三个方向都要咬住。 */
function expectCompleted(r: ProbeRun): void {
  expect(r.error?.message).toBeUndefined()
  expect(`${r.signal ?? 'no-signal'} status=${r.status}`).toBe('no-signal status=0')
  expect(r.stdout).toContain('RESULT done')
}

/** 抓住 `logger.warn` 那条 JSON —— 它直接写 `process.stderr.write`。 */
function captureStderr(fn: () => void): string {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }) as never)
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return chunks.join('')
}

describe('daemon token 文件：类型闸', () => {
  it(
    'FIFO ⇒ loadOrCreateToken 跑完并点名报错，不是干等（且不替它重建）',
    () => {
      const home = makeHome()
      const fifo = join(home, '.mipham', 'daemon.token')
      mkfifo(fifo)

      const r = runProbe('load', home, fifo)

      expectCompleted(r)
      expect(r.stdout).toContain('RESULT threw=named')
      // FIFO 还在原地：任何「当成不存在、重建一份」的写法都会把它 rename 掉。
      expect(statSync(fifo).isFIFO()).toBe(true)
    },
    PROBE_TEST_TIMEOUT,
  )

  it(
    'FIFO ⇒ listTokens 同一条闸（第二个读者，修前一样挂住）',
    () => {
      const home = makeHome()
      const fifo = join(home, '.mipham', 'daemon.token')
      mkfifo(fifo)

      const r = runProbe('list', home, fifo)

      expectCompleted(r)
      expect(r.stdout).toContain('RESULT threw=named')
    },
    PROBE_TEST_TIMEOUT,
  )

  it('目录 ⇒ 点名报错，不是裸 EISDIR', () => {
    // 这一格修前是**抛错**（EISDIR）不是挂住，所以进程内测是安全的。
    const home = makeHome()
    const p = join(home, '.mipham', 'daemon.token')
    mkdirSync(p)

    expect(() => loadOrCreateToken(p)).toThrow(/not a regular file/)
  })

  it('普通文件 ⇒ 照常读回（闸不粘）', () => {
    const home = makeHome()
    const p = join(home, '.mipham', 'daemon.token')
    writeFileSync(p, 'aaaa\n', { mode: 0o600 })

    expect(loadOrCreateToken(p)).toBe('aaaa')
    expect(listTokens(p)).toEqual(['aaaa'])
  })

  it('文件缺席 ⇒ 照旧是「创建」而不是抛错', () => {
    const home = makeHome()
    const p = join(home, '.mipham', 'daemon.token')

    const token = loadOrCreateToken(p)

    expect(token).toHaveLength(64)
    expect(modeOf(p)).toBe('600')
  })
})

describe('daemon token 文件：权限修复', () => {
  it('0644 漂开 ⇒ 读一次收回 0600，并把 before/after 说出来', () => {
    const home = makeHome()
    const p = join(home, '.mipham', 'daemon.token')
    writeFileSync(p, 'bbbb\n', { mode: 0o644 })
    expect(modeOf(p)).toBe('644')

    let value = ''
    const stderr = captureStderr(() => {
      value = loadOrCreateToken(p)
    })

    expect(value).toBe('bbbb')
    expect(modeOf(p)).toBe('600')
    const entry = JSON.parse(stderr.trim()) as Record<string, unknown>
    expect(entry.level).toBe('warn')
    expect(entry.path).toBe(p)
    expect(entry.from).toBe('644')
    expect(entry.to).toBe('600')
  })

  it('本来就是 0600 ⇒ 不出声（告警跟着漂移走，不是无条件打印）', () => {
    // 这一格是上一条的良构对照：没有它，「有 warn」可能只是每条都印。
    const home = makeHome()
    const p = join(home, '.mipham', 'daemon.token')
    writeFileSync(p, 'cccc\n', { mode: 0o600 })

    const stderr = captureStderr(() => {
      loadOrCreateToken(p)
    })

    expect(stderr).toBe('')
    expect(modeOf(p)).toBe('600')
  })

  it('listTokens 读到漂开的 0644 同样收回（修复在唯一那个读者里，不在某个调用点）', () => {
    const home = makeHome()
    const p = join(home, '.mipham', 'daemon.token')
    writeFileSync(p, 'dddd\n', { mode: 0o644 })

    const stderr = captureStderr(() => {
      expect(listTokens(p)).toEqual(['dddd'])
    })

    expect(modeOf(p)).toBe('600')
    expect(stderr).toContain('tightened')
  })
})

describe('daemon token 文件：第三个读者（真 CLI 的 attach）', () => {
  it(
    'mipham attach 在 token 路径是 FIFO 时跑完并点名报错 —— 证明它走的是同一个读者',
    () => {
      // 修前这一格是**挂住**：attach 曾把 `existsSync + readFileSync` 内联了一遍，
      // 那份拷贝没有类型闸。判据必须让它能红，否则「attach 走了同一个读者」这句话
      // 只是一句注释。
      const home = makeHome()
      const fifo = join(home, '.mipham', 'daemon.token')
      mkfifo(fifo)
      // `getDaemonStatus()` 只要求 PID 文件里的进程还活着 —— 放进测试进程自己，
      // 于是 attach 一路走到读 token 那一行。
      writeFileSync(join(home, '.mipham', 'daemon.pid'), String(process.pid))

      const r = spawnSync('bun', [join(CLI_DIR, 'bin', 'mipham.ts'), 'attach'], {
        cwd: dir,
        env: probeEnv(home),
        encoding: 'utf-8',
        timeout: WATCHDOG_MS,
        killSignal: 'SIGTERM',
      })

      expect(r.error?.message).toBeUndefined()
      expect(`${r.signal ?? 'no-signal'}`).toBe('no-signal')
      expect(r.stderr).toContain('is not a regular file')
      expect(statSync(fifo).isFIFO()).toBe(true)
    },
    PROBE_TEST_TIMEOUT,
  )
})
