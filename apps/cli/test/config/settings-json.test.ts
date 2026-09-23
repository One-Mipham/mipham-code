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

  // Guard against over-gating: the same file also carries `permissions`, and
  // that question is answered elsewhere (allow rules are capped by the mode
  // ceiling — P2). Trust has no say in it.
  it('still merges project permissions with the default gate closed', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git:*)'], deny: ['Bash(rm:*)'] } }),
    )
    const r = loadSettingsJson(CWD)
    expect(r.permissions.allow).toEqual(['Bash(git:*)'])
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

  // `permissions.defaultMode` 是**天花板**，不是规则：allow/deny 只在档位允许的范围内
  // 说话（上一条注释里的理由），而 defaultMode 决定那个范围本身。所以它与 allow/deny
  // 必须分开对待 —— 项目级那份随代码到达，不能替操作者选闸门。
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
      // 扣的是**一个键**，不是整份文件：allow/deny 依旧合并（那是规则，不是天花板）。
      expect(r.permissions.allow).toEqual(['Read'])
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
      // 非字符串／空串同样不算「声明过」—— 标记与它报告的事实取自同一次解析，
      // 与 `projectHooksSkipped` 同一条规矩。
      writeProject({ defaultMode: 123 })
      expect(loadSettingsJson(CWD).projectModeSkipped).toBeUndefined()
      writeProject({ defaultMode: '   ' })
      expect(loadSettingsJson(CWD).projectModeSkipped).toBeUndefined()
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

  it('loads and dedupes permissions allow/deny across levels', () => {
    writeFileSync(
      join(CWD, '.mipham', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git:*)'], deny: ['Bash(rm:*)'] } }),
    )
    writeFileSync(
      join(MIPHAM_HOME, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git:*)', 'Read(*)'], deny: ['Bash(rm:*)'] } }),
    )
    const r = loadSettingsJson(CWD)
    expect(r.permissions.allow).toEqual(['Bash(git:*)', 'Read(*)'])
    expect(r.permissions.deny).toEqual(['Bash(rm:*)'])
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
