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

// `permission` 是唯一一个**项目级不生效**的键：它决定闸门，而项目文件随代码到达。
// （settings.json 那边同一件事记在 `test/config/settings-json.test.ts` 的
// `permissions.defaultMode` 一组里 —— 同一扇门的两个镜像。）
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
