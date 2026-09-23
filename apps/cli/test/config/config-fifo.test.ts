/**
 * 配置路径上出现**非普通文件**（FIFO）时，CLI 启动不得挂住。
 *
 * 要证明的那个现象是「阻塞」。`readFileSync` 读一个没有写者的 FIFO 会一直等下去，
 * 而且这是**同步**阻塞 —— vitest 的用例超时、定时器、signal handler 全都排不上队，
 * 回归发生时整个 worker 一起僵住：套件不会红，只会不动。所以判据一律跑在**子进程**
 * 里，配 `spawnSync` 的硬超时：真回归了，读数就是 `signal=SIGTERM`，是一条**能红**
 * 的断言；而不是一次无人察觉的僵死。
 *
 * 判据取「子进程真的跑完并且印出标记」而不是「没超时」—— 后者在子进程压根没起来
 * （比如 `bun` 不在 PATH、脚本有语法错）时同样为真，那是假绿。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../../src/config/defaults'

const CLI_DIR = join(import.meta.dirname, '..', '..')
/** 实测子进程冷启动 + 导入整条配置链 ≈ 40ms；15s 是「几乎不可能到」的上限。 */
const WATCHDOG_MS = 15_000
/** 看门狗自己也占时间，用例超时必须比它宽 —— 否则报的是 vitest 超时，不是我们的读数。 */
const PROBE_TEST_TIMEOUT = 30_000

const DEFAULT_PROVIDER_COUNT = DEFAULT_CONFIG.providers.length
const USER_PROBE_CONFIG = 'providers:\n  - id: probe\n    apiKey: plain-key\n'
const BACKUP_NAME = 'config.backup-2026-01-01T00-00-00-000Z.yml'

type ProbeMode = 'load' | 'fifo-read' | 'siblings'

const abs = (rel: string): string => JSON.stringify(join(CLI_DIR, rel))

const PROBE_SOURCES: Record<ProbeMode, string> = {
  // 启动链本体：真的 loadConfig()，并把 config.yml 在事后是什么**类型**报出来
  // （FIFO 还在 = 没有任何一条路径往里写过东西）。
  load: `
import { loadConfig } from ${abs('src/config/loader.ts')}
import { statSync } from 'node:fs'
const home = process.env.HOME
const c = loadConfig(process.argv[2])
let kind = 'gone'
try {
  const s = statSync(home + '/.mipham/config.yml')
  kind = s.isFIFO() ? 'fifo' : s.isFile() ? 'file' : 'other'
} catch {}
console.log('RESULT load providers=' + c.providers.length + ' kind=' + kind)
`,
  'fifo-read': `
import { readRegularFileSync } from ${abs('src/shared/regular-file.ts')}
const value = readRegularFileSync(process.argv[2])
console.log('RESULT fifo-read ' + (value === null ? 'null' : JSON.stringify(value)))
`,
  // 同一批 ~/.mipham 兄弟文件：keys.json / preferences.json / .cred-key
  siblings: `
import { KeyManager } from ${abs('src/config/keys-manager.ts')}
import { getPreference } from ${abs('src/config/preferences.ts')}
import { getCredentialKey } from ${abs('src/config/credential-crypto.ts')}
import { statSync } from 'node:fs'
const dir = process.env.HOME + '/.mipham'
console.log('RESULT keys=' + new KeyManager().list().length)
console.log('RESULT pref=' + getPreference('probe.key', 'default-value'))
try {
  getCredentialKey(dir)
  console.log('RESULT cred=no-throw')
} catch (err) {
  console.log('RESULT cred=threw:' + String(err && err.message).includes('not a regular file'))
}
const stillFifos = ['keys.json', 'preferences.json', '.cred-key'].filter((f) => {
  try {
    return statSync(dir + '/' + f).isFIFO()
  } catch {
    return false
  }
}).length
console.log('RESULT fifos=' + stillFifos + '/3')
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
  dir = mkdtempSync(join(tmpdir(), 'mipham-config-fifo-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeHome(): string {
  const home = mkdtempSync(join(dir, 'home-'))
  mkdirSync(join(home, '.mipham'), { recursive: true })
  return home
}

function makeProject(): string {
  const proj = mkdtempSync(join(dir, 'proj-'))
  mkdirSync(join(proj, '.mipham'), { recursive: true })
  return proj
}

function mkfifo(path: string): void {
  execFileSync('mkfifo', [path])
}

function runProbe(mode: ProbeMode, home: string, arg?: string): ProbeRun {
  const script = join(dir, `probe-${mode}.ts`)
  writeFileSync(script, PROBE_SOURCES[mode])
  // 子进程自成一档环境：HOME 指向夹具目录（`miphamHome()` 是**调用时**求值，
  // 且这些模块在导入时就把结果捕获进常量），MIPHAM_* 一律剥掉免得串味。
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  for (const key of Object.keys(env)) {
    if (key.startsWith('MIPHAM_')) delete env[key]
  }
  const r = spawnSync('bun', [script, ...(arg ? [arg] : [])], {
    cwd: dir,
    env,
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
  expect(r.stdout).toContain('RESULT')
}

describe('配置路径是 FIFO', () => {
  it(
    '正对照：普通 config.yml 照常被读到（证明探针本身是接通的）',
    () => {
      const home = makeHome()
      writeFileSync(join(home, '.mipham', 'config.yml'), USER_PROBE_CONFIG)
      const r = runProbe('load', home, makeProject())

      expectCompleted(r)
      expect(r.stdout).toContain(`providers=${DEFAULT_PROVIDER_COUNT + 1}`)
      expect(r.stdout).toContain('kind=file')
      expect(r.stderr).not.toContain('ignoring it')
    },
    PROBE_TEST_TIMEOUT,
  )

  it(
    '用户 config.yml 是 FIFO + 旁边有备份 ⇒ 返回、不读它、也不往它里面还原',
    () => {
      const home = makeHome()
      const fifo = join(home, '.mipham', 'config.yml')
      mkfifo(fifo)
      // 有备份在 ⇒ 若判据仍是 `existsSync`，就会走「损坏了，尝试恢复」那条路，
      // 而 `copyFileSync(备份, FIFO)` 会挡在「等读者」上 —— 挂死。
      writeFileSync(join(home, '.mipham', BACKUP_NAME), USER_PROBE_CONFIG)

      const r = runProbe('load', home, makeProject())

      expectCompleted(r)
      // 用户级配置没被应用：读的是**零**，不是 FIFO 里的内容（它也没有内容）。
      expect(r.stdout).toContain(`providers=${DEFAULT_PROVIDER_COUNT}`)
      expect(r.stdout).toContain('kind=fifo')
      expect(r.stderr).toContain('is not a readable regular file')
      expect(r.stderr).not.toContain('corrupted')
      expect(r.stderr).not.toContain('restored config from backup')
    },
    PROBE_TEST_TIMEOUT,
  )

  it(
    '项目 .mipham/config.yml 是 FIFO ⇒ 返回，用户级配置照常生效',
    () => {
      const home = makeHome()
      writeFileSync(join(home, '.mipham', 'config.yml'), USER_PROBE_CONFIG)
      const proj = makeProject()
      mkfifo(join(proj, '.mipham', 'config.yml'))

      const r = runProbe('load', home, proj)

      expectCompleted(r)
      expect(r.stdout).toContain(`providers=${DEFAULT_PROVIDER_COUNT + 1}`)
      expect(r.stdout).toContain('kind=file')
      expect(r.stderr).toContain('project config')
      expect(r.stderr).not.toContain('corrupted')
    },
    PROBE_TEST_TIMEOUT,
  )

  it(
    'readRegularFileSync 读 FIFO 直接返回 null',
    () => {
      const home = makeHome()
      const fifo = join(home, '.mipham', 'config.yml')
      mkfifo(fifo)

      const r = runProbe('fifo-read', home, fifo)

      expectCompleted(r)
      expect(r.stdout).toContain('fifo-read null')
    },
    PROBE_TEST_TIMEOUT,
  )

  it(
    'keys.json / preferences.json / .cred-key 是 FIFO ⇒ 不挂住，凭证键明确报错而不是干等',
    () => {
      const home = makeHome()
      for (const name of ['keys.json', 'preferences.json', '.cred-key']) {
        mkfifo(join(home, '.mipham', name))
      }

      const r = runProbe('siblings', home)

      expectCompleted(r)
      expect(r.stdout).toContain('keys=0')
      expect(r.stdout).toContain('pref=default-value')
      expect(r.stdout).toContain('cred=threw:true')
      // 三个都还留在原地，说明没有任何一条路径从它们「恢复/迁移」过。
      expect(r.stdout).toContain('fifos=3/3')
    },
    PROBE_TEST_TIMEOUT,
  )

  it('FIFO 之后放回普通文件 ⇒ 配置照常读（闸门不粘）', () => {
    // 这条留在进程内没关系：路径上最终是普通文件，不可能阻塞。
    const home = makeHome()
    const path = join(home, '.mipham', 'config.yml')
    mkfifo(path)
    rmSync(path, { force: true })
    writeFileSync(path, USER_PROBE_CONFIG)

    const r = runProbe('load', home, makeProject())

    expectCompleted(r)
    expect(r.stdout).toContain(`providers=${DEFAULT_PROVIDER_COUNT + 1}`)
    expect(r.stdout).toContain('kind=file')
  })
})

describe('夹具自检', () => {
  it('mkfifo 建的确实是 FIFO，不是普通文件', () => {
    const p = join(dir, 'self-check.fifo')
    mkfifo(p)
    expect(statSync(p).isFIFO()).toBe(true)
    expect(statSync(p).isFile()).toBe(false)
  })
})
