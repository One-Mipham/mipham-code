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
import { ALL_MODES, PERMISSION_MODE_HIERARCHY, clampMode } from '../../src/core/permission-config'

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

// 这一组钉的是同一个家族的**第三个键**：`permissionRestrictions`。前两个是放宽方向，一眼
// 看得出该拒；这一个**名义上就是收窄的**（它的存在意义就是给档位封顶），所以从来没被问过
// —— 而它有一个出口：`clampMode` 从被请求的档**向下**找落点，若该档及其以下全被禁就走到底，
// 回落到 `allowed[0]`，那是**更宽**的一档。禁掉最窄的 `plan` 正是制造这个情形的办法
// （实测：`forbiddenModes: [default, acceptEdits, plan]` + 请求 `plan` ⇒ 落到 `auto`，宽 4 阶）。
//
// 处置沿用 F2-2 立的判据（收窄 → 收下；放宽 → 不收），但**落到值一级**：`maxAllowedMode`
// 照收（穷举全部 25 个 cap × 请求档，从不改宽），`forbiddenModes` 只扣掉「最窄那一档」这个
// 成员，其余照收。保住最窄那一档是**充分**的：任何请求档 D 向下走，最窄档 ≤ D 且被允许，
// 故永远找得到落点、永远进不了回落分支。
describe('loadConfig — 项目级 permissionRestrictions：收窄的收下，会改宽的那个成员扣下', () => {
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

  it('封顶照收，并且**说出口**（改写发生在一处，之后没有任何东西再提它）', () => {
    writeProjectConfig('permissionRestrictions:\n  maxAllowedMode: plan\n')
    const config = loadConfig(CWD)
    expect(config.permissionRestrictions).toEqual({ maxAllowedMode: 'plan' })
    const said = allStderr()
    expect(said).toContain('permission modes pinned by project config')
    expect(said).toContain(join(CWD, '.mipham', 'config.yml'))
    expect(said).toContain('maxAllowedMode: plan')
  })

  it('扣的是**这一个成员**，不是整张表：禁宽档的条目照样收下', () => {
    // 少了这条，一个「项目级 restrictions 一律不看」的实现也能让下面那条全绿。
    writeProjectConfig('permissionRestrictions:\n  forbiddenModes: [plan, bypassPermissions]\n')
    const config = loadConfig(CWD)
    expect(config.permissionRestrictions).toEqual({ forbiddenModes: ['bypassPermissions'] })
    expect(allStderr()).toContain('ignored permissionRestrictions.forbiddenModes ["plan"]')
  })

  it('别名与大小写同样认得（判据在这一格里最容易漏：归一化只有一张表）', () => {
    // 若这里另写一份判据、只比字面量 `'plan'`，`Plan` 会滑过闸门，随后被
    // `normalizeRestrictions` 归一成 `plan` —— 闸门就成了摆设。
    for (const spelling of ['Plan', 'PLAN', ' plan ']) {
      rmSync(join(CWD, '.mipham'), { recursive: true, force: true })
      writeProjectConfig(`permissionRestrictions:\n  forbiddenModes: ["${spelling}"]\n`)
      const config = loadConfig(CWD)
      expect(config.permissionRestrictions).toBeUndefined()
      expect(allStderr()).toContain('ignored permissionRestrictions.forbiddenModes')
    }
  })

  it('只剩被扣的那一条 ⇒ 整键不留（不改变用户自己那张表的形状）', () => {
    writeProjectConfig('permissionRestrictions:\n  forbiddenModes: [plan]\n')
    writeUserConfig('permissionRestrictions:\n  forbiddenModes: [bypassPermissions]\n')
    const config = loadConfig(CWD)
    expect(config.permissionRestrictions).toEqual({ forbiddenModes: ['bypassPermissions'] })
    expect(allStderr()).toContain('ignored permissionRestrictions.forbiddenModes')
  })

  it('写坏了的 forbiddenModes 原样交出去 —— 校验仍只有 normalizeRestrictions 一处', () => {
    // 字符串不是数组：这里**不改写**它（改了就是本文件长出第二个部分校验器，
    // 哪天加一档模式两边就会漂移）。它是 fail-closed 的：认不出 ⇒ 封顶到最严一档。
    writeProjectConfig('permissionRestrictions:\n  forbiddenModes: "plan"\n')
    const config = loadConfig(CWD)
    expect(config.permissionRestrictions).toEqual({ forbiddenModes: 'plan' })
    expect(allStderr()).not.toContain('ignored permissionRestrictions.forbiddenModes')
  })

  it('用户级那扇门照旧：扣的是**来源**，不是这个键', () => {
    // 正对照。用户自己的文件里禁最窄一档仍是他的自由（组织策略可以由它封顶），
    // 本笔只拦「随代码到达」的那一份 —— 别把这条读成「这个键被废掉了」。
    writeUserConfig('permissionRestrictions:\n  forbiddenModes: [plan]\n')
    expect(loadConfig(CWD).permissionRestrictions).toEqual({ forbiddenModes: ['plan'] })
    expect(allStderr()).not.toContain('permission modes pinned')
  })

  it('没写就不吭声（播报不能自己冒出来）', () => {
    writeProjectConfig('defaultModel: project-model\n')
    loadConfig(CWD)
    expect(allStderr()).not.toContain('permission modes pinned')
    expect(allStderr()).not.toContain('permissionRestrictions')
  })

  it('区间不变量：仓库带来的 32 种 forbiddenModes 里，没有一种能把请求的档改宽', () => {
    // 数人头救不了这个键 —— 它的问题是「某些输入的输出比输入更宽」，那是**区间性质**。
    // 所以这里遍历全部 2^5 个子集 × 5 个请求档，逐格问「clamp 之后有没有比请求的更宽」，
    // 且走的是**真 loadConfig 的产物**（不是把剥离规则在测试里重写一遍）。
    const rank = (m: string): number => PERMISSION_MODE_HIERARCHY.indexOf(m as never)
    let cells = 0
    const widened: string[] = []

    for (let mask = 0; mask < 1 << ALL_MODES.length; mask++) {
      const raw = ALL_MODES.filter((_, i) => (mask >> i) & 1)
      rmSync(join(CWD, '.mipham'), { recursive: true, force: true })
      writeProjectConfig(`permissionRestrictions:\n  forbiddenModes: [${raw.join(', ')}]\n`)
      const restrictions = loadConfig(CWD).permissionRestrictions
      for (const desired of ALL_MODES) {
        cells++
        const got = clampMode(desired, restrictions)
        if (rank(got) > rank(desired))
          widened.push(`${JSON.stringify(raw)} 请求 ${desired} → ${got}`)
      }
    }

    expect(widened).toEqual([])
    // 自证前提：遍历真的跑满了（循环写坏/早退时上面那条会**恒真**）。
    expect(cells).toBe(160) // 32 个子集（含空集）× 5 个请求档
    // 正对照：把同一批输入**不经剥离**直接喂给 clampMode，确实有格子会改宽 —— 少了它，
    // 上面那条不变量可能只是在描述一个恒等于空集的形状。
    expect(
      ALL_MODES.some((d) => rank(clampMode(d, { forbiddenModes: ['plan', 'default'] })) > rank(d)),
    ).toBe(true)
  })

  it('两个来源叠在一起时也不会更宽 —— 闸在项目那扇门上，所以只有这一格看得见「相加」', () => {
    // 上一格只喂**一个**来源。运行时真正的输入是合并后的那一份，而合并是逐子键的
    // （数组替换、对象合并，user 在最后一层）⇒ 仓库的那一份永远**加不进**用户已有的表。
    // 这一格把两者的**全部**组合走一遍。
    //
    // 两条路已经在别处量过，这里只把剩下的那条补上：
    //   · 用户没写 forbiddenModes ⇒ 生效的就是仓库那份 ⇒ 上一格的 160 格；
    //   · 用户写了 ⇒ 用户那份**替换**它（下面第一条用例钉住这个机制），仓库那份不参与。
    // 于是唯一还没量的组合是「用户禁了某几档 **+** 仓库封顶」—— 封顶本身不改宽，但回落
    // 分支此时是**活的**（用户禁了最窄档 ⇒ 请求它也走回落），所以必须实测而不是推演。
    const rank = (m: string): number => PERMISSION_MODE_HIERARCHY.indexOf(m as never)
    const yaml = (modes: string[]): string =>
      modes.length > 0
        ? `permissionRestrictions:\n  forbiddenModes: [${modes.join(', ')}]\n`
        : 'showThinking: off\n'
    let cells = 0
    const widened: string[] = []

    for (let mask = 0; mask < 1 << ALL_MODES.length; mask++) {
      const banned = ALL_MODES.filter((_, i) => (mask >> i) & 1)
      // 基线：**只**有用户那份文件时的落点
      rmSync(join(CWD, '.mipham'), { recursive: true, force: true })
      writeUserConfig(yaml(banned))
      const userOnly = loadConfig(CWD).permissionRestrictions

      for (let pmask = 0; pmask < 1 << ALL_MODES.length; pmask++) {
        const projectBans = ALL_MODES.filter((_, i) => (pmask >> i) & 1)
        rmSync(join(CWD, '.mipham'), { recursive: true, force: true })
        writeProjectConfig(yaml(projectBans))
        // 合并值由**真加载器**给出 —— 不在这里把合并语义重写一遍（那正是本仓库的老形状）。
        const merged = loadConfig(CWD).permissionRestrictions
        for (const desired of ALL_MODES) {
          cells++
          const withRepo = rank(clampMode(desired, merged))
          const withoutRepo = rank(clampMode(desired, userOnly))
          if (withRepo > withoutRepo)
            widened.push(
              `用户禁 ${JSON.stringify(banned)} + 仓库禁 ${JSON.stringify(projectBans)}：请求 ${desired} 第 ${withoutRepo} 阶 → 第 ${withRepo} 阶`,
            )
        }
      }
    }

    expect(widened).toEqual([])
    expect(cells).toBe(5120) // 32 个用户基线 × 32 个仓库禁止集 × 5 个请求档
    // 正对照：同一格网格里，**不经剥离**的仓库侧确实能把用户的落点推宽。
    expect(
      ALL_MODES.some(
        (d) => rank(clampMode(d, { forbiddenModes: ['plan'] })) > rank(clampMode(d, {})),
      ),
    ).toBe(true)
  })

  it('用户自己禁了最窄档时回落分支是活的 —— 但仓库的封顶推不动它', () => {
    // 跨来源里唯一还需要点名的一格：用户禁 `plan` 之后，请求 `plan` 走的是
    // `clampMode` 的**回落**（那条分支只在「请求档及其以下全被禁」时才可达）。
    // 此时仓库再封顶，落点会不会被推宽？实测不会 —— 封顶只从上面砍，而回落取的是
    // `ALL_MODES` 里第一个活着的档（`default`），与封顶无关。
    writeUserConfig('permissionRestrictions:\n  forbiddenModes: [plan]\n')
    expect(clampMode('plan', loadConfig(CWD).permissionRestrictions)).toBe('default')

    writeProjectConfig('permissionRestrictions:\n  maxAllowedMode: plan\n')
    expect(clampMode('plan', loadConfig(CWD).permissionRestrictions)).toBe('default')

    // 顺带记下同一格上的**既有**兜底（不是本笔造成、也不由仓库侧触发）：用户禁 `plan`
    // 再加上封顶 `plan` 会把 allowed 掏空（`[plan]` ∩ 禁 plan = 空），此时
    // `clampMode` 落到最后那句 `allowed[0] ?? 'default'` ⇒ 又是 `default`，比封顶更宽。
    // 掏空这一步只能由**用户自己**的禁令完成（仓库侧那份 `[plan]` 已被本笔扣下），
    // 故它属于「用户自己把最窄档禁掉之后兜底去哪」的问题，留作残余。
    expect(clampMode('plan', { forbiddenModes: ['plan'], maxAllowedMode: 'plan' })).toBe('default')
  })

  it('用户自己写了 forbiddenModes 时，仓库那一份进不来（数组替换、不是并集）', () => {
    // 上一条不变量赖以成立的前提，单列一格钉住 —— 若哪天合并改成并集，
    // 「仓库的表永远加不进用户已有的表」就不成立了，而上面那条会变得**无法证伪**。
    writeProjectConfig('permissionRestrictions:\n  forbiddenModes: [bypassPermissions]\n')
    writeUserConfig('permissionRestrictions:\n  forbiddenModes: [default]\n')
    expect(loadConfig(CWD).permissionRestrictions).toEqual({ forbiddenModes: ['default'] })
    // 且仓库那份仍照常被**通报**（被合并语义吃掉，不是被这道闸吃掉）
    expect(allStderr()).toContain('permission modes pinned by project config')
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
