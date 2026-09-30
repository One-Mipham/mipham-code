import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate from the real ~/.mipham — loadSettingsJson reads settings.json there.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-settings-json`,
  }
})

import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadSettingsJson, addSettingsRule, removeSettingsRule } from '../../src/config/loader'

const MIPHAM_HOME = join(homedir(), '.mipham')
const CWD = join(homedir(), 'proj')

describe('loadSettingsJson', () => {
  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(join(CWD, '.mipham'), { recursive: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
  })

  it('returns empty when no settings.json exists', () => {
    expect(loadSettingsJson(CWD)).toEqual({ hooks: {}, permissions: { allow: [], deny: [] } })
  })

  it('loads project-level hooks when the caller vouches for the workspace', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'block.sh' }] }],
        },
      }),
    )
    const r = loadSettingsJson(CWD, { includeProjectHooks: true })
    expect(r.hooks.PreToolUse).toHaveLength(1)
    expect(r.hooks.PreToolUse![0]!.matcher).toBe('Bash')
  })

  it('merges project + user hooks additively (Claude convention)', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'p.sh' }] }] },
      }),
    )
    writeFileSync(
      join(MIPHAM_HOME, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'u.sh' }] }] },
      }),
    )
    const r = loadSettingsJson(CWD, { includeProjectHooks: true })
    expect(r.hooks.PreToolUse).toHaveLength(2)
  })

  // The project file is repository-controlled and its `hooks` spawn processes,
  // so reading them is an explicit act. The default is the closed direction: a
  // caller that has not established trust gets user hooks only.
  it('drops project hooks by default — they are repository-controlled code execution', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'p.sh' }] }] },
      }),
    )
    writeFileSync(
      join(MIPHAM_HOME, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'u.sh' }] }] },
      }),
    )

    const r = loadSettingsJson(CWD)

    // Not merely "fewer" — the project entry must be absent by name, so a
    // future change that merges it under a different key still reddens here.
    expect(r.hooks.PreToolUse).toHaveLength(1)
    expect(r.hooks.PreToolUse![0]!.matcher).toBe('Edit')
  })

  // Guard against over-gating: the same file also carries `permissions`, and the
  // two directions inside it are **not** the same question.
  //
  // This test used to assert that `allow` merged across levels too, on the stated
  // grounds that "allow rules are capped by the mode ceiling — P2". That premise
  // is false: `maxAllowedMode` is opt-in and `allowRuleDecision` returns `bypass`
  // when it is absent, so an uncapped allow rule *is* the approval gate rather
  // than a rule inside it. `deny` still merges — it narrows. Full rule in the
  // `permissions.allow` describe below.
  it('still merges project deny with the default gate closed — and withholds allow', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git:*)'], deny: ['Bash(rm:*)'] } }),
    )
    const r = loadSettingsJson(CWD)
    expect(r.permissions.allow).toEqual([])
    expect(r.projectAllowSkipped).toBe(true)
    expect(r.permissions.deny).toEqual(['Bash(rm:*)'])
  })

  // The skip is reported from the same parse that would have read the hooks, so
  // a caller announcing it cannot announce one that never happened.
  it('reports the skip when project hooks really were withheld', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'p.sh' }] }] },
      }),
    )
    expect(loadSettingsJson(CWD).projectHooksSkipped).toBe(true)
  })

  it('reports no skip when the project file declared no hooks', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read'] } }),
    )
    expect(loadSettingsJson(CWD).projectHooksSkipped).toBeUndefined()
  })

  it('reports no skip when the caller vouched for the workspace', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'p.sh' }] }] },
      }),
    )
    expect(loadSettingsJson(CWD, { includeProjectHooks: true }).projectHooksSkipped).toBeUndefined()
  })

  // `permissions.defaultMode` 是**天花板**，不是规则：它决定 allow/deny 说话的范围本身，
  // 所以项目级那份随代码到达的不能替操作者选闸门。
  //
  // ⚠️ 本注释原写作「allow/deny 只在档位允许的范围内说话（上一条注释里的理由），故与
  // defaultMode 必须分开对待」—— **那个前提是假的**。只有配置了 `maxAllowedMode` 才有
  // 「档位允许的范围」，而它默认缺席；此时 `allowRuleDecision` 直接返回 `bypass`。于是
  // 项目级 allow 规则在默认配置下等于免审批 —— 与 defaultMode 是同一件事的两种写法，
  // 而它当初被当成了「规则」放行。合并规则见下面那个 describe。
  describe('permissions.defaultMode（天花板：只认用户级）', () => {
    const writeProject = (permissions: unknown): void => {
      writeFileSync(join(CWD, '.mipham', 'settings.json'), JSON.stringify({ permissions }))
    }
    const writeUser = (permissions: unknown): void => {
      writeFileSync(join(MIPHAM_HOME, 'settings.json'), JSON.stringify({ permissions }))
    }

    it('用户级照收，且**原样**透传（值域不在这里判）', () => {
      writeUser({ defaultMode: 'plan' })
      expect(loadSettingsJson(CWD).permissions.defaultMode).toBe('plan')
      // 一个不存在的模式同样原样上来：接受哪些拼写、以及不认识时怎么告警，只有一个
      // 地方有权回答（`setDefaultLevel` 与它的 `MODE_LIST`）。在这里补一道校验 = 第二
      // 份值域，加档那天两份会分叉 —— 而分叉点正好是「哪扇门接受它」。
      writeUser({ defaultMode: 'yolo' })
      expect(loadSettingsJson(CWD).permissions.defaultMode).toBe('yolo')
    })

    it('项目级**不**采纳，且照 allow/deny 的同一次解析报出「扣了」', () => {
      writeProject({ defaultMode: 'bypassPermissions', allow: ['Read'] })
      const r = loadSettingsJson(CWD)
      expect(r.permissions.defaultMode).toBeUndefined()
      expect(r.projectModeSkipped).toBe(true)
      // 扣的是**一个键**，不是整份文件：deny 依旧合并（它收窄）。而 allow 在这份文件里
      // 同样被扣 —— 理由与 defaultMode 字面上相同（仓库不能替操作者选闸门），见下个
      // describe。本格同时钉住「两个标记互相独立」：这份文件两个键都写了，两个都要报。
      expect(r.permissions.allow).toEqual([])
      expect(r.projectAllowSkipped).toBe(true)
    })

    it('信任了也一样不采纳 —— 这道闸门不看信任', () => {
      // 判别点：`includeProjectHooks: true` 是**另一个问题**的答案（hooks 会跑命令，
      // 问的是「这个目录你认不认」）。天花板问的是「谁在替操作者决定要不要审批」，
      // 答案与信任无关 —— 仓库的主人可能正是被 clone 的那个人不知道的那位。
      // 这一条与上一条只差一个参数，正是「只修一半」会漏掉的那一半。
      writeProject({ defaultMode: 'auto' })
      const r = loadSettingsJson(CWD, { includeProjectHooks: true })
      expect(r.permissions.defaultMode).toBeUndefined()
      expect(r.projectModeSkipped).toBe(true)
    })

    it('两份都写了：用户级的赢，且仍然报出项目那份被扣', () => {
      writeProject({ defaultMode: 'auto' })
      writeUser({ defaultMode: 'plan' })
      const r = loadSettingsJson(CWD)
      expect(r.permissions.defaultMode).toBe('plan')
      expect(r.projectModeSkipped).toBe(true)
    })

    it('标记不能自己冒出来：没写模式的文件（含只写 allow 的）不留标记', () => {
      writeProject({ allow: ['Read'] })
      const r = loadSettingsJson(CWD)
      expect(r.permissions.defaultMode).toBeUndefined()
      expect(r.projectModeSkipped).toBeUndefined()
      // 两个标记各报各的事实：这份文件声明了 allow 而没声明模式 ⇒ 只有 allow 那个响。
      expect(r.projectAllowSkipped).toBe(true)
      // 非字符串／空串同样不算「声明过」—— 标记与它报告的事实取自同一次解析，
      // 与 `projectHooksSkipped` 同一条规矩。
      writeProject({ defaultMode: 123 })
      expect(loadSettingsJson(CWD).projectModeSkipped).toBeUndefined()
      writeProject({ defaultMode: '   ' })
      expect(loadSettingsJson(CWD).projectModeSkipped).toBeUndefined()
    })

    it('从 home 目录启动时那份文件**就是**用户级的 —— 不扣，也不留标记', () => {
      // `cwd === ~` 时 `join(cwd, '.mipham')` 与 `MIPHAM_HOME` 是同一个目录：写在那里的
      // 就是用户自己的文件。按项目级扣掉等于拒绝用户自己的设置，再在告警里指名**同一个
      // 文件**让他去那里设置。
      writeUser({ defaultMode: 'plan' })
      const r = loadSettingsJson(homedir())
      expect(r.permissions.defaultMode).toBe('plan')
      expect(r.projectModeSkipped).toBeUndefined()
    })

    it('负控：home 的**子目录**里那份仍是项目级（判据是同一个目录，不是前缀）', () => {
      // 写成 `cwd.startsWith(homedir())` 会连 `~/proj` 一起豁免 —— 而那正是最常见的
      // 项目位置。`CWD` 就是 home 的子目录，这一格钉住判据的形状。
      writeProject({ defaultMode: 'auto' })
      const r = loadSettingsJson(CWD)
      expect(r.permissions.defaultMode).toBeUndefined()
      expect(r.projectModeSkipped).toBe(true)
    })
  })

  // `permissions.allow` 与 `defaultMode` 是**同一个方向**：放宽。而「放宽到哪算过分」这个
  // 问题，只有配置了 `maxAllowedMode` 才有人回答 —— 默认无人回答，`allowRuleDecision` 在
  // 那条路径上直接返回 `bypass`（`permission.ts`:795）。所以项目级 allow 规则在默认配置下
  // 就是「免审批」，与 defaultMode 是同一件事的两种写法，必须同样只认用户级。
  //
  // 与它相对的是 `deny`：收窄方向，允许仓库自带 —— 判据是宽窄，不是「allow/deny 是规则
  // 所以随便合并」（那正是本次修正的前提）。
  describe('permissions.allow（放宽方向：只认用户级）', () => {
    const writeProject = (permissions: unknown): void => {
      writeFileSync(join(CWD, '.mipham', 'settings.json'), JSON.stringify({ permissions }))
    }
    const writeUser = (permissions: unknown): void => {
      writeFileSync(join(MIPHAM_HOME, 'settings.json'), JSON.stringify({ permissions }))
    }

    it('项目级 allow **不**采纳，并报出被扣；同一份文件里的 deny 照常合并', () => {
      writeProject({ allow: ['Bash(npm test)'], deny: ['Bash(rm:*)'] })
      const r = loadSettingsJson(CWD)
      // 扣的是**方向**，不是文件、也不是整个 permissions 表：同一份文件里的 deny 仍然到位。
      expect(r.permissions.allow).toEqual([])
      expect(r.permissions.deny).toEqual(['Bash(rm:*)'])
      expect(r.projectAllowSkipped).toBe(true)
    })

    it('用户级 allow 照收，且不留标记（正对照：扣的是「项目级」，不是「allow」）', () => {
      writeUser({ allow: ['Bash(npm test)'] })
      const r = loadSettingsJson(CWD)
      expect(r.permissions.allow).toEqual(['Bash(npm test)'])
      // 没有这一格，上面那条「allow 为空」可能只是因为 allow 压根没被读。
      expect(r.projectAllowSkipped).toBeUndefined()
    })

    it('两份都写了 allow：用户级的到位，项目那份被扣并报出', () => {
      writeProject({ allow: ['Bash(rm -rf /)'] })
      writeUser({ allow: ['Read(*)'] })
      const r = loadSettingsJson(CWD)
      expect(r.permissions.allow).toEqual(['Read(*)'])
      expect(r.projectAllowSkipped).toBe(true)
    })

    it('信任了也一样扣 —— 与 defaultMode 同一条理由，这道闸门不看信任', () => {
      writeProject({ allow: ['Bash(npm test)'] })
      const r = loadSettingsJson(CWD, { includeProjectHooks: true })
      expect(r.permissions.allow).toEqual([])
      expect(r.projectAllowSkipped).toBe(true)
    })

    it('标记不能自己冒出来：`allow: []` / 非数组 / 全是非字符串都不算「声明过」', () => {
      // 「声明过」的判据取自**同一次解析**里真会进入合并的那些条目，与
      // `projectHooksSkipped`（`entries.length > 0`）和 `projectModeSkipped`（非空字符串）
      // 同一规矩 —— 否则一个空数组就能让调用方喊出一次没发生的跳过。
      writeProject({ allow: [] })
      expect(loadSettingsJson(CWD).projectAllowSkipped).toBeUndefined()
      writeProject({ allow: 'Bash(npm test)' })
      expect(loadSettingsJson(CWD).projectAllowSkipped).toBeUndefined()
      writeProject({ allow: [123, null, {}] })
      expect(loadSettingsJson(CWD).projectAllowSkipped).toBeUndefined()
      // 而混着一条真规则时，报道的是**真发生过的**这一次扣留。
      writeProject({ allow: [123, 'Bash(npm test)'] })
      expect(loadSettingsJson(CWD).projectAllowSkipped).toBe(true)
    })

    it('负控：home 的**子目录**里那份仍是项目级（判据是同一个目录，不是前缀）', () => {
      writeProject({ allow: ['Bash(npm test)'] })
      expect(loadSettingsJson(CWD).permissions.allow).toEqual([])
      // 而从 home 本身启动时那份就是用户级 —— 不扣。
      writeUser({ allow: ['Bash(npm test)'] })
      expect(loadSettingsJson(homedir()).permissions.allow).toEqual(['Bash(npm test)'])
    })
  })

  // The merged `hooks` list is provenance-free: once project and user entries sit
  // in one bucket, no caller can tell which is which — and the two are governed
  // differently (project hooks are gated on workspace trust, user hooks are not).
  // A caller that *displays* the list sees project hooks even when they are
  // gated, so it needs the split to say so.
  describe('project hook provenance', () => {
    const PROJECT_HOOK = { type: 'command', command: 'p.sh' }
    const USER_HOOK = { type: 'command', command: 'u.sh' }

    function writeProject(hooks: unknown): void {
      writeFileSync(join(CWD, '.mipham', 'settings.json'), JSON.stringify({ hooks }))
    }
    function writeUser(hooks: unknown): void {
      writeFileSync(join(MIPHAM_HOME, 'settings.json'), JSON.stringify({ hooks }))
    }

    it('separates the project file’s entries from the merged list', () => {
      writeProject({ PreToolUse: [{ matcher: 'Bash', hooks: [PROJECT_HOOK] }] })
      writeUser({ PreToolUse: [{ matcher: 'Edit', hooks: [USER_HOOK] }] })

      const r = loadSettingsJson(CWD, { includeProjectHooks: true })

      expect(r.projectHooks?.PreToolUse).toHaveLength(1)
      expect(r.projectHooks?.PreToolUse?.[0]?.hooks).toEqual([PROJECT_HOOK])
      // …and the merge is untouched: both entries still arrive, project first.
      expect(r.hooks.PreToolUse).toHaveLength(2)
      expect(r.hooks.PreToolUse?.[1]?.hooks).toEqual([USER_HOOK])
    })

    it('omits projectHooks when the caller did not vouch for the workspace', () => {
      writeProject({ PreToolUse: [{ matcher: 'Bash', hooks: [PROJECT_HOOK] }] })

      const r = loadSettingsJson(CWD)

      expect(r.projectHooks).toBeUndefined()
      expect(r.projectHooksSkipped).toBe(true)
    })

    it('omits projectHooks when the project file declared none', () => {
      writeProject({})
      writeUser({ PreToolUse: [{ matcher: 'Edit', hooks: [USER_HOOK] }] })

      const r = loadSettingsJson(CWD, { includeProjectHooks: true })

      // Same "only when it happened" rule as `projectHooksSkipped`: an empty
      // marker must stay indistinguishable from no marker, or a caller tags
      // user hooks as gated on the strength of a file with nothing in it.
      expect(r.projectHooks).toBeUndefined()
      expect(r.hooks.PreToolUse).toHaveLength(1)
    })

    it('omits projectHooks when the project file declared only empty buckets', () => {
      writeProject({ PreToolUse: [] })

      const r = loadSettingsJson(CWD, { includeProjectHooks: true })

      expect(r.projectHooks).toBeUndefined()
    })
  })

  it('dedupes deny across levels; allow comes from the user level alone', () => {
    // 原名「loads and dedupes permissions allow/deny across levels」—— 对 allow 而言
    // 「across levels」正是本次修掉的那件事，名字留在这里会把已修的行为说成还在。
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git:*)'], deny: ['Bash(rm:*)'] } }),
    )
    writeFileSync(
      join(MIPHAM_HOME, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(git:*)', 'Bash(git:*)', 'Read(*)'], deny: ['Bash(rm:*)'] },
      }),
    )
    const r = loadSettingsJson(CWD)
    // deny：两份都算，逐条去重（项目那份与用户那份是同一条，只留一条；用户文件内
    // 自己重复的那条也去掉）。
    expect(r.permissions.deny).toEqual(['Bash(rm:*)'])
    // allow：只有用户级那一份，文件内去重后原序保留。
    expect(r.permissions.allow).toEqual(['Bash(git:*)', 'Read(*)'])
    expect(r.projectAllowSkipped).toBe(true)
  })

  it('skips corrupt JSON files', () => {
    writeFileSync(join(CWD, '.mipham', 'settings.json'), 'not json')
    const r = loadSettingsJson(CWD)
    expect(r.hooks).toEqual({})
    expect(r.permissions).toEqual({ allow: [], deny: [] })
  })
})

describe('settings rule persistence', () => {
  const projectSettings = join(CWD, '.mipham', 'settings.json')

  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(join(CWD, '.mipham'), { recursive: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
  })

  const read = () => JSON.parse(readFileSync(projectSettings, 'utf-8'))

  it('creates settings.json with the rule', () => {
    const path = addSettingsRule('allow', 'Bash(npm test)', 'project', CWD)
    expect(path).toBe(projectSettings)
    expect(read().permissions.allow).toEqual(['Bash(npm test)'])
  })

  it('round-trips through loadSettingsJson', () => {
    addSettingsRule('deny', 'Bash(rm *)', 'project', CWD)
    expect(loadSettingsJson(CWD).permissions.deny).toEqual(['Bash(rm *)'])
  })

  it('preserves hooks and unmodelled keys', () => {
    writeFileSync(
      projectSettings,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
        futureKey: { keep: true },
      }),
    )
    addSettingsRule('allow', 'Read', 'project', CWD)
    const doc = read()
    expect(doc.hooks.PreToolUse).toHaveLength(1)
    expect(doc.futureKey).toEqual({ keep: true })
    expect(doc.permissions.allow).toEqual(['Read'])
  })

  it('is idempotent — re-adding does not duplicate', () => {
    addSettingsRule('allow', 'Read', 'project', CWD)
    addSettingsRule('allow', 'Read', 'project', CWD)
    expect(read().permissions.allow).toEqual(['Read'])
  })

  it('refuses to clobber a malformed file', () => {
    writeFileSync(projectSettings, 'not json')
    expect(() => addSettingsRule('allow', 'Read', 'project', CWD)).toThrow(/not valid JSON/)
    expect(readFileSync(projectSettings, 'utf-8')).toBe('not json')
  })

  it('removes from allow and reports where it was', () => {
    addSettingsRule('allow', 'Read', 'project', CWD)
    expect(removeSettingsRule('Read', 'project', CWD)).toEqual({
      path: projectSettings,
      key: 'allow',
    })
    expect(read().permissions.allow).toEqual([])
  })

  it('removes from deny when the rule lives there', () => {
    addSettingsRule('deny', 'Bash(rm *)', 'project', CWD)
    expect(removeSettingsRule('Bash(rm *)', 'project', CWD)?.key).toBe('deny')
    expect(read().permissions.deny).toEqual([])
  })

  it('returns null and leaves the file alone when the rule is absent', () => {
    addSettingsRule('allow', 'Read', 'project', CWD)
    const before = readFileSync(projectSettings, 'utf-8')
    expect(removeSettingsRule('Bash(nope)', 'project', CWD)).toBeNull()
    expect(readFileSync(projectSettings, 'utf-8')).toBe(before)
  })
})

// ============================================================
// 读不动 / 读不了 的 settings.json 必须**出声**。
//
// `readRegularFileSync` 把「不存在」与「在、但读不出来」（EACCES、目录、FIFO）
// 折成同一个 `null`。前者是常态（大多数路径本来就没有文件），后者不是：
// 那个文件里写着 `permissions.deny`，读不到 = 这份 deny 整条不生效，而
// **失败的方向是变松的**。安全相关的文件不允许悄悄 fail-open。
//
// 两半各测一条，且都以「这条警告**不该**在正常情形出现」作反方向对照 ——
// 否则一个无条件写 stderr 的实现也能让上半段全绿。
// ============================================================

describe('loadSettingsJson — 读不了的 settings.json 要说出来', () => {
  const USER_SETTINGS = join(MIPHAM_HOME, 'settings.json')

  // 上面那个 `describe` 的 beforeEach/afterEach 只作用于它自己那一块，
  // 兄弟块得自带一份 —— 否则目录都不存在，`writeFileSync` 直接 ENOENT。
  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(join(CWD, '.mipham'), { recursive: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
  })

  /** 抓住这一段里往 stderr 写的东西。 */
  function captureStderr(fn: () => void): string {
    const chunks: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => {
      chunks.push(String(c))
      return true
    }) as typeof process.stderr.write)
    try {
      fn()
    } finally {
      spy.mockRestore()
    }
    return chunks.join('')
  }

  it('文件在、JSON 坏了 ⇒ 报出路径与原因，且那份 deny **没有**生效', () => {
    // 截断的 JSON：`deny` 已经写进去了，但整份文件读不出来。
    writeFileSync(USER_SETTINGS, '{ "permissions": { "deny": ["Bash(rm -rf *)"] }')

    let result: ReturnType<typeof loadSettingsJson> | undefined
    const stderr = captureStderr(() => {
      result = loadSettingsJson(CWD)
    })

    expect(stderr).toContain('failed to parse settings file')
    expect(stderr).toContain(USER_SETTINGS)
    // 说实话：文件被**整份忽略**了，不是「解析成功但没有 deny」。
    expect(result!.permissions.deny).toEqual([])
  })

  it('反方向：JSON 正常时一声不出，且 deny 真的进来了', () => {
    writeFileSync(USER_SETTINGS, JSON.stringify({ permissions: { deny: ['Bash(rm -rf *)'] } }))

    let result: ReturnType<typeof loadSettingsJson> | undefined
    const stderr = captureStderr(() => {
      result = loadSettingsJson(CWD)
    })

    expect(stderr).toBe('')
    expect(result!.permissions.deny).toEqual(['Bash(rm -rf *)'])
  })

  it('文件在、但不是普通文件（此处是目录）⇒ 报出路径，不当作「不存在」', () => {
    mkdirSync(USER_SETTINGS, { recursive: true })

    const stderr = captureStderr(() => {
      loadSettingsJson(CWD)
    })

    expect(stderr).toContain('not a readable regular file')
    expect(stderr).toContain(USER_SETTINGS)
  })

  it('反方向：文件**不在**时保持安静（那才是常态）', () => {
    expect(() => readFileSync(USER_SETTINGS)).toThrow() // 前提：确实没这个文件

    const stderr = captureStderr(() => {
      loadSettingsJson(CWD)
    })

    expect(stderr).toBe('')
  })
})
