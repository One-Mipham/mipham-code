/**
 * 会话日志 / workflow journal 的路径上出现 **FIFO** 时不得挂住 —— 判据取**接线**，
 * 不是助手本身（助手有没有闸门由 `test/shared/regular-file.test.ts` 管）。
 *
 * 为什么非要一条单独的接线判据：本仓库的惯犯是「有定义、无施加点」—— 助手写得再对，
 * 只要某个调用点还是裸 `readFileSync` / `appendFileSync`，那条链照样挂。字符串在、
 * 接线断，断言照样绿（这正是 2.93.0 那条教训）。这里每一条都用**真调用点**跑：
 * `SessionLog.open`、`SessionLog.save`、`appendJournal`。
 *
 * 为什么跑在**子进程**里：要证明的现象是「阻塞」，而 `readFileSync` 读没有写者的 FIFO
 * 是**同步**阻塞 —— vitest 的用例超时、定时器、signal handler 全排不上队，回归发生时
 * 整个 worker 只会僵住（套件不变红）。子进程配 `spawnSync` 的硬超时，判据取「子进程真跑
 * 完并印出标记」，而不是「没超时」：后者在子进程压根没起来时也成立，是假绿。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI_DIR = join(import.meta.dirname, '..', '..')
/** 实测子进程冷启动 + 导入这条链 ≈ 40ms；15s 是「几乎不可能到」的上限。 */
const WATCHDOG_MS = 15_000
const PROBE_TEST_TIMEOUT = 30_000

const abs = (rel: string): string => JSON.stringify(join(CLI_DIR, rel))

type ProbeMode = 'log-open' | 'log-save' | 'journal-append'

/**
 * 每个探针都在**自己的 HOME** 里跑，并在 import 之前把 `.mipham/sessions/` 铺好、
 * 把目标路径换成 FIFO —— 这几个模块的目录常量是 **import 时**求值的（`miphamHome`
 * 在模块顶层被调用），先 import 再改 HOME 量到的就是另一个对象。
 */
const PROBES: Record<ProbeMode, string> = {
  'log-open': `
import { mkdirSync } from 'node:fs'
mkdirSync(process.env.HOME + '/.mipham/sessions', { recursive: true })
import { execFileSync } from 'node:child_process'
execFileSync('mkfifo', [process.env.HOME + '/.mipham/sessions/fifo-probe.jsonl'])
const { SessionLog } = await import(${abs('src/core/session-log.ts')})
const log = SessionLog.open('fifo-probe')
console.log('RESULT log-open events=' + log.events().length)
`,
  'log-save': `
import { mkdirSync, statSync } from 'node:fs'
mkdirSync(process.env.HOME + '/.mipham/sessions', { recursive: true })
import { execFileSync } from 'node:child_process'
const p = process.env.HOME + '/.mipham/sessions/fifo-probe.jsonl'
execFileSync('mkfifo', [p])
const { SessionLog } = await import(${abs('src/core/session-log.ts')})
const log = new SessionLog('fifo-probe')
log.append({ type: 'session/start', at: 1, sessionId: 'fifo-probe' })
log.save()
const kind = statSync(p).isFIFO() ? 'fifo' : 'not-fifo'
console.log('RESULT log-save kind=' + kind)
`,
  'journal-append': `
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const dir = process.env.HOME + '/.mipham/workflows/fifo-run'
mkdirSync(dir, { recursive: true })
execFileSync('mkfifo', [dir + '/journal.jsonl'])
const { appendJournal } = await import(${abs('src/workflow/journal.ts')})
let outcome = 'no-throw'
try {
  appendJournal('fifo-run', { type: 'log', message: 'x' })
} catch (e) {
  outcome = 'threw:' + (e && e.message ? e.message : String(e))
}
console.log('RESULT journal-append ' + outcome)
`,
}

function runProbe(mode: ProbeMode): {
  ok: boolean
  stdout: string
  status: number | null
  signal: string | null
} {
  const home = mkdtempSync(join(tmpdir(), 'mipham-fifo-wiring-'))
  try {
    const r = spawnSync('bun', ['-e', PROBES[mode]], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
      timeout: WATCHDOG_MS,
      killSignal: 'SIGTERM',
    })
    return { ok: true, stdout: r.stdout ?? '', status: r.status, signal: r.signal }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('会话日志 / journal 的 FIFO 接线', () => {
  it('mkfifo 可用（没有它，下面的读数全是假的）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-mkfifo-'))
    try {
      execFileSync('mkfifo', [join(dir, 'f')])
      expect(statSync(join(dir, 'f')).isFIFO()).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it(
    'SessionLog.open 读 FIFO：不挂，当空日志（从前会同步阻塞到有写者为止）',
    () => {
      const r = runProbe('log-open')
      expect(r.signal, `看门狗开火了 —— 回归：子进程被 ${r.signal} 杀掉`).toBeNull()
      expect(r.stdout).toContain('RESULT log-open events=0')
    },
    PROBE_TEST_TIMEOUT,
  )

  it(
    'SessionLog.save 写 FIFO：不挂、不覆盖它，原路径仍是 FIFO',
    () => {
      const r = runProbe('log-save')
      expect(r.signal, `看门狗开火了 —— 回归：子进程被 ${r.signal} 杀掉`).toBeNull()
      // `kind=fifo` 说明没有任何一条路径把内容写了进去（写了就变普通文件了）
      expect(r.stdout).toContain('RESULT log-save kind=fifo')
    },
    PROBE_TEST_TIMEOUT,
  )

  it(
    'appendJournal 写 FIFO：当场抛错（不做影子、不挂）',
    () => {
      const r = runProbe('journal-append')
      expect(r.signal, `看门狗开火了 —— 回归：子进程被 ${r.signal} 杀掉`).toBeNull()
      expect(r.stdout).toContain('RESULT journal-append threw:')
      expect(r.stdout).toContain('not appendable')
    },
    PROBE_TEST_TIMEOUT,
  )
})
