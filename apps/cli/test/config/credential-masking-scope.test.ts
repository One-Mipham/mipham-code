import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 项目级 config 从 `<cwd>/.mipham/config.yml` 读，用户级从 `~/.mipham/config.yml`
// 读 —— 两个都得挪开，否则测的是开发机上的真实配置。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-masking-scope` }
})

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadCredentialMaskingConfig } from '../../src/config/loader'
import { matchCredentialFile } from '../../src/core/credential-masker'

const ROOT = join(tmpdir(), 'mipham-test-masking-scope')
const MIPHAM_HOME = join(ROOT, '.mipham')
const PROJECT = join(ROOT, 'cloned-repo')

const writeUser = (body: string) => writeFileSync(join(MIPHAM_HOME, 'config.yml'), body, 'utf-8')
const writeProject = (body: string) => {
  mkdirSync(join(PROJECT, '.mipham'), { recursive: true })
  writeFileSync(join(PROJECT, '.mipham', 'config.yml'), body, 'utf-8')
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(MIPHAM_HOME, { recursive: true })
  mkdirSync(PROJECT, { recursive: true })
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

// ============================================================
// 两个配置层级的**权力边界**。
//
// 用户级 `~/.mipham/config.yml` 是用户自己的东西（受信）；项目级
// `<cwd>/.mipham/config.yml` 是**你 clone 下来的那个仓库**带来的（不受信）。
// 原实现两层同权、项目级后读（"project wins"），于是 `enabled: false` 一行就能
// 关掉这个控制，`files: [...]` 则**整片顶掉**默认规则（`.env` / `~/.ssh/id_*` 全没了）
// —— 都是 clone 一个仓库就能造成的**静默降级**。
//
// `mergeProviders` 里 `baseUrl` 早已按同一条道理分权（只有受信的用户级能覆盖路由），
// 这里对齐它：项目级只能**收紧** —— 能打开、能加规则，不能关、不能删。
// ============================================================
describe('credential_masking 的项目级只能收紧', () => {
  it('项目级写 enabled:false 关不掉掩码', () => {
    writeProject('credential_masking:\n  enabled: false\n')
    expect(loadCredentialMaskingConfig(PROJECT).enabled).toBe(true)
  })

  it('项目级关不掉 output_scrubbing / env_filter', () => {
    writeProject(
      'credential_masking:\n  output_scrubbing:\n    enabled: false\n  env_filter:\n    enabled: false\n',
    )
    const config = loadCredentialMaskingConfig(PROJECT)
    expect(config.output_scrubbing.enabled).toBe(true)
    expect(config.env_filter.enabled).toBe(true)
  })

  it('项目级 files 是**追加**，不是顶替 —— 默认规则一条都不少', () => {
    writeProject(
      'credential_masking:\n  files:\n    - path: "**/project-only.txt"\n      mode: full\n',
    )
    const config = loadCredentialMaskingConfig(PROJECT)

    // 自带的那条在
    expect(config.files.map((f) => f.path)).toContain('**/.env*')
    // 项目加的那条也在
    expect(config.files.map((f) => f.path)).toContain('**/project-only.txt')
  })

  it('用户已经给了规则的路径，项目级加第二条也压不掉（先匹配到的赢）', () => {
    // 用户把 `**/.env*` 收紧成 full；项目想用一个 extract 规则把它降级。
    writeUser('credential_masking:\n  files:\n    - path: "**/.env*"\n      mode: full\n')
    writeProject(
      'credential_masking:\n  files:\n    - path: "**/.env*"\n      mode: extract\n      extract:\n        - pattern: "NOTHING_MATCHES"\n',
    )
    const config = loadCredentialMaskingConfig(PROJECT)
    const matched = matchCredentialFile('/tmp/x/.env', config)
    // 规则是个联合类型（JWT / AWS 那些没有 `mode`），先收窄再读。
    expect(matched && 'mode' in matched ? matched.mode : undefined).toBe('full')
  })

  it('项目级**能**收紧：用户关了掩码，项目级可以重新打开', () => {
    // 这一条防的是「把项目级整段忽略掉」也蒙混过关 —— 收紧方向必须真的生效。
    writeUser('credential_masking:\n  enabled: false\n')
    writeProject('credential_masking:\n  enabled: true\n')
    expect(loadCredentialMaskingConfig(PROJECT).enabled).toBe(true)
  })
})

describe('用户级仍是受信的（可以放宽）', () => {
  it('用户级写 enabled:false 就是关（项目里什么都没写）', () => {
    writeUser('credential_masking:\n  enabled: false\n')
    expect(loadCredentialMaskingConfig(PROJECT).enabled).toBe(false)
  })

  it('用户级 files 仍是整体替换（用户有权重排自己的规则）', () => {
    writeUser('credential_masking:\n  files:\n    - path: "**/only-mine.txt"\n      mode: full\n')
    const config = loadCredentialMaskingConfig(PROJECT)
    expect(config.files.map((f) => f.path)).toEqual(['**/only-mine.txt'])
  })
})
