import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate from the real ~/.mipham — loadConfig() reads (and may create) config.yml there.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-config-merge`,
  }
})

import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from '../../src/config/loader'

const MIPHAM_HOME = join(homedir(), '.mipham')
const CWD = join(homedir(), 'proj')

function writeProjectConfig(yaml: string): void {
  mkdirSync(join(CWD, '.mipham'), { recursive: true })
  writeFileSync(join(CWD, '.mipham', 'config.yml'), yaml, 'utf-8')
}

function writeUserConfig(yaml: string): void {
  mkdirSync(MIPHAM_HOME, { recursive: true })
  writeFileSync(join(MIPHAM_HOME, 'config.yml'), yaml, 'utf-8')
}

describe('loadConfig — object-valued keys merge across sources', () => {
  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
  })

  it('keeps sibling keys of a two-level object (features.mcp vs features.context)', () => {
    // project sets one branch, user sets the other — a shallow merge lets the
    // user-level `features` replace the whole object and drop `context`.
    writeProjectConfig('features:\n  context:\n    adaptiveThresholds: false\n')
    writeUserConfig('features:\n  mcp:\n    oauthEnabled: false\n')

    const config = loadConfig(CWD)

    expect(config.features?.context?.adaptiveThresholds).toBe(false)
    expect(config.features?.mcp?.oauthEnabled).toBe(false)
  })

  it('keeps sibling keys of crsi flags', () => {
    // Both read as `!== false`, so a dropped key silently reverts to the default (on).
    writeProjectConfig('crsi:\n  preToolHook: false\n')
    writeUserConfig('crsi:\n  ruleInjection: false\n')

    const config = loadConfig(CWD)

    expect(config.crsi?.preToolHook).toBe(false)
    expect(config.crsi?.ruleInjection).toBe(false)
  })

  it('keeps skills.paths when another source sets only skills.reminder', () => {
    writeProjectConfig('skills:\n  paths:\n    - /proj/skills\n')
    writeUserConfig('skills:\n  reminder: "off"\n')

    const config = loadConfig(CWD)

    expect(config.skills?.paths).toEqual(['/proj/skills'])
    expect(config.skills?.reminder).toBe('off')
  })

  it('keeps permissionRules.deny when another source sets only permissionRules.allow', () => {
    writeProjectConfig('permissionRules:\n  deny:\n    - "Read(**/.npmrc)"\n')
    writeUserConfig('permissionRules:\n  allow:\n    - "Bash(git status)"\n')

    const config = loadConfig(CWD)

    expect(config.permissionRules?.deny).toEqual(['Read(**/.npmrc)'])
    expect(config.permissionRules?.allow).toEqual(['Bash(git status)'])
  })

  it('replaces arrays rather than concatenating them across sources', () => {
    // Guard: an override must not append to the other source's list.
    writeProjectConfig('skills:\n  paths:\n    - /proj/skills\n')
    writeUserConfig('skills:\n  paths:\n    - /user/skills\n')

    const config = loadConfig(CWD)

    expect(config.skills?.paths).toEqual(['/user/skills'])
  })

  it('still lets a scalar in the higher-precedence source win', () => {
    writeProjectConfig('defaultModel: project-model\n')
    writeUserConfig('defaultModel: user-model\n')

    expect(loadConfig(CWD).defaultModel).toBe('user-model')
  })
})

// 项目级 config.yml 里**不生效**的两个键：`permission` 与 `permissionRules.allow`。
// 两个都是**放宽**方向 —— 一个替你选闸门，一个从闸门里放行 —— 而项目文件随代码到达。
// （settings.json 那边同一件事记在 `test/config/settings-json.test.ts` 的
// `permissions.defaultMode` 与 `permissions.allow` 两组里 —— 同一扇门的两个镜像。）
describe('loadConfig — 项目级 config.yml 不选权限档', () => {
  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const allStderr = (): string =>
    vi
      .mocked(process.stderr.write)
      .mock.calls.map((c) => String(c[0]))
      .join('')
  const warnings = (): string[] =>
    vi
      .mocked(process.stderr.write)
      .mock.calls.map((c) => String(c[0]))
      .filter((s) => s.includes('permission'))

  it('拒绝项目级的档位，并**说出口**（静默丢弃与没读文件同形）', () => {
    writeProjectConfig('permission: bypassPermissions\n')
    const config = loadConfig(CWD)
    expect(config.permission).toBe('default')
    const said = warnings().join('')
    expect(said).toContain('ignored permission: bypassPermissions')
    expect(said).toContain(join(CWD, '.mipham', 'config.yml'))
  })

  it('只扣这一个键：同一个文件里的其它键照旧合并', () => {
    // 少了这条，一个「把项目配置整个跳过」的实现也能让上面的断言全绿。
    writeProjectConfig('permission: auto\ndefaultModel: project-model\n')
    const config = loadConfig(CWD)
    expect(config.permission).toBe('default')
    expect(config.defaultModel).toBe('project-model')
  })

  it('用户级那扇门照旧：这是同一个键的另一半，不是把键废掉', () => {
    writeProjectConfig('permission: bypassPermissions\n')
    writeUserConfig('permission: plan\n')
    expect(loadConfig(CWD).permission).toBe('plan')
  })

  it('没写就不告警（告警不能自己冒出来）', () => {
    writeProjectConfig('defaultModel: project-model\n')
    loadConfig(CWD)
    expect(warnings()).toEqual([])
  })

  it('从备份恢复出来的那一份同样不生效（项目文件进了两次，闸门只有一道）', () => {
    // 项目 config.yml 损坏 → 走 `tryRestoreFromBackup` → 恢复出来的仍是**项目级**内容。
    // 用户级那份必须是好的，否则它也会去恢复同一份备份，把档位从**用户**那扇门放进来
    // ——那时这条断言会绿得毫无意义。
    mkdirSync(MIPHAM_HOME, { recursive: true })
    writeFileSync(
      join(MIPHAM_HOME, 'config.backup-2026-01-01T00-00-00-000Z.yml'),
      'permission: bypassPermissions\n',
      'utf-8',
    )
    writeFileSync(join(MIPHAM_HOME, 'config.yml'), 'defaultModel: user-model\n', 'utf-8')
    writeProjectConfig('permission: [unclosed\n')

    const config = loadConfig(CWD)

    expect(config.permission).toBe('default')
    expect(config.defaultModel).toBe('user-model')
    expect(warnings().join('')).toContain('ignored permission: bypassPermissions')
    // 自证前提：这条走的是**恢复**那条分支。YAML 若把那种写法当合法（它没报错），
    // 上面三行会在「根本没恢复」的情况下同样成立 —— 断言的前提必须自己说出来。
    expect(allStderr()).toContain('restored config from backup')
  })
})

// 上面那组钉的是「项目级那份不生效」。这一组钉同一扇门的**第二个镜像**：
// `permissionRules.allow` 与 `permission` 是同一个方向（放宽），而 `permissionRules.deny`
// 是反方向（收窄，可以随代码到达）。判据是**宽窄**，不是「它挂在哪个键下面」—— 把 allow
// 当成「规则」而放行，正是本次修正的前提错误：只有配了 `maxAllowedMode` 才有「档位允许的
// 范围」，而它默认缺席（`permission.ts` 的 `allowRuleDecision` 在那条路径上直接返回
// `bypass`）。这条闸门与 `settings.json` 那边是同一件事的两个镜像。
describe('loadConfig — 项目级 config.yml 不选 allow 规则', () => {
  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const allStderr = (): string =>
    vi
      .mocked(process.stderr.write)
      .mock.calls.map((c) => String(c[0]))
      .join('')

  it('项目级 allow 不采纳、并**说出口**；同一份文件里的 deny 照收', () => {
    writeProjectConfig(
      'permissionRules:\n  allow:\n    - "Bash(npm test)"\n  deny:\n    - "Read(**/.npmrc)"\n',
    )
    const config = loadConfig(CWD)
    // 扣的是**方向**，不是整张表：同一份文件里的 deny 仍然到位。
    expect(config.permissionRules?.allow).toBeUndefined()
    expect(config.permissionRules?.deny).toEqual(['Read(**/.npmrc)'])
    const said = allStderr()
    expect(said).toContain('ignored permissionRules.allow')
    expect(said).toContain(join(CWD, '.mipham', 'config.yml'))
  })

  it('用户级 allow 照收（正对照：扣的是「项目级」，不是「allow」）', () => {
    writeUserConfig('permissionRules:\n  allow:\n    - "Bash(npm test)"\n')
    expect(loadConfig(CWD).permissionRules?.allow).toEqual(['Bash(npm test)'])
    // 没有这一格，上面那条「allow 为 undefined」可能只是因为 allow 压根没被读。
    expect(allStderr()).not.toContain('ignored permissionRules')
  })

  it('两份都写了 allow：用户级的到位，项目那份被扣并报出', () => {
    writeProjectConfig('permissionRules:\n  allow:\n    - "Bash(rm -rf /)"\n')
    writeUserConfig('permissionRules:\n  allow:\n    - "Bash(npm test)"\n')
    const config = loadConfig(CWD)
    expect(config.permissionRules?.allow).toEqual(['Bash(npm test)'])
    expect(allStderr()).toContain('ignored permissionRules.allow')
  })

  it('只写了 allow 的项目文件不会把用户级的整张表挤掉（剥完为空 ⇒ 不留空表）', () => {
    // 若剥完留下 `permissionRules: {}` 再合并进去，深合并里它是空对象、看着无害 ——
    // 但「项目文件只提及 allow」这件事不该改变用户自己那张表的形状，留下空表就会让
    // `config.permissionRules` 对一个只提 allow 的仓库变成真值。
    writeProjectConfig('permissionRules:\n  allow:\n    - "Bash(rm -rf /)"\n')
    writeUserConfig(
      'permissionRules:\n  allow:\n    - "Bash(npm test)"\n  deny:\n    - "Read(**/.env)"\n',
    )
    const config = loadConfig(CWD)
    expect(config.permissionRules).toEqual({
      allow: ['Bash(npm test)'],
      deny: ['Read(**/.env)'],
    })
  })

  it('标记不能自己冒出来：`allow: []` / 非数组都不算「声明过」', () => {
    writeProjectConfig('permissionRules:\n  allow: []\n')
    expect(allStderr()).not.toContain('ignored permissionRules')
    writeProjectConfig('permissionRules:\n  allow: "Bash(npm test)"\n')
    expect(allStderr()).not.toContain('ignored permissionRules')
  })

  it('负控：home 的**子目录**里那份照旧扣并告警', () => {
    writeProjectConfig('permissionRules:\n  allow:\n    - "Bash(npm test)"\n')
    expect(loadConfig(CWD).permissionRules?.allow).toBeUndefined()
    expect(allStderr()).toContain('ignored permissionRules.allow')
  })

  it('而从 home 本身启动时那份是用户自己的 —— 不扣，也不告警', () => {
    writeUserConfig('permissionRules:\n  allow:\n    - "Bash(npm test)"\n')
    expect(loadConfig(homedir()).permissionRules?.allow).toEqual(['Bash(npm test)'])
    expect(allStderr()).not.toContain('ignored permissionRules')
  })
})

// 这一组钉的是**它什么时候根本不是项目级**：
// 从 home 目录启动时 `join(cwd, '.mipham')` 与 `MIPHAM_HOME` 是同一个目录，那份
// config.yml 就是用户自己的 —— 再按项目级剥离，等于把用户亲手写的档位拒绝掉。
describe('loadConfig — 从 home 目录启动时没有「项目级」', () => {
  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const allStderr = (): string =>
    vi
      .mocked(process.stderr.write)
      .mock.calls.map((c) => String(c[0]))
      .join('')

  it('用户自己的 ~/.mipham/config.yml 不再被当成仓库配置剥离', () => {
    writeUserConfig('permission: bypassPermissions\n')
    const config = loadConfig(homedir())
    expect(config.permission).toBe('bypassPermissions')
    expect(allStderr()).not.toContain('ignored permission')
  })

  it('负控：home 的**子目录**里那份照旧剥离并告警', () => {
    writeProjectConfig('permission: bypassPermissions\n')
    const config = loadConfig(CWD) // CWD = homedir()/proj —— 前缀相同，目录不同
    expect(config.permission).toBe('default')
    expect(allStderr()).toContain('ignored permission: bypassPermissions')
  })
})

describe('loadConfig — .mcp.json keeps the full server shape', () => {
  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
    mkdirSync(CWD, { recursive: true })
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
  })

  it('carries request_timeout_ms and auth through from .mcp.json', () => {
    writeFileSync(
      join(CWD, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          forge: {
            url: 'https://forge.example/mcp',
            request_timeout_ms: 12345,
            auth: {
              type: 'oauth',
              authorizationUrl: 'https://forge.example/oauth/authorize',
              tokenUrl: 'https://forge.example/oauth/token',
              clientId: 'mipham-cli',
              scopes: ['mcp'],
            },
          },
        },
      }),
      'utf-8',
    )

    const server = loadConfig(CWD).skills?.mcpServers.find((s) => s.name === 'forge')

    expect(server).toBeDefined()
    expect(server?.request_timeout_ms).toBe(12345)
    expect(server?.auth?.clientId).toBe('mipham-cli')
    expect(server?.auth?.scopes).toEqual(['mcp'])
  })
})
