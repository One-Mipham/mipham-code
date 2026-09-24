import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate from the real ~/.mipham — /permissions also reads user settings.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-permissions` }
})

import { rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PermissionSystem } from '../../src/core/permission'
import { permissionsCmd, setupCmd } from '../../src/commands/project'
import { ALL_MODES, MODE_CYCLE, PERMISSION_MODE_HIERARCHY } from '../../src/core/permission-config'
import type { TranslationMap } from '../../src/i18n-core/types'
import type { ToolDefinition } from '../../src/shared'

const CWD = join(homedir(), 'proj')
const settingsPath = join(CWD, '.mipham', 'settings.json')

const writeTool: ToolDefinition = {
  name: 'Write',
  description: 'Write a file',
  category: 'file',
  permission: 'ask',
  parameters: { type: 'object', properties: {} },
  async execute() {
    return { success: true, content: '' }
  },
}

/**
 * C4 (方案甲): `/permissions allow <rule>` is the explicit persistence point
 * for "always allow". These tests pin that it (a) lands in settings.json,
 * (b) takes effect in the live permission system, not just on next start, and
 * (c) refuses a rule that could never match.
 */
describe('/permissions — rule persistence & mode help', () => {
  let perm: PermissionSystem

  function makeCtx() {
    return {
      engine: {
        getPermission: () => perm,
        getContext: () => ({ getMessages: () => [] }),
        getTools: () => new Map(),
      },
      // `providers` is an array in a real context; `/setup` with no step arg
      // counts them, so a shapeless stub only fails once something reads it.
      config: { permission: 'default', providers: [] },
      t: (k: string) => k,
    } as unknown as Parameters<typeof permissionsCmd>[0]
  }

  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(join(CWD, '.mipham'), { recursive: true })
    // The command resolves the project scope from process.cwd().
    vi.spyOn(process, 'cwd').mockReturnValue(CWD)
    perm = new PermissionSystem('plan')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(homedir(), { recursive: true, force: true })
  })

  it('writes an allow rule to settings.json', async () => {
    await permissionsCmd(makeCtx(), ['allow', 'Write'])
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow).toEqual(['Write'])
  })

  it('takes effect in the live session, not only after restart', async () => {
    // plan mode denies writes by baseline.
    expect(perm.check(writeTool, {})).toBe('ask')
    await permissionsCmd(makeCtx(), ['allow', 'Write'])
    expect(perm.check(writeTool, {})).toBe('bypass')
  })

  it('writes a deny rule and blocks in the live session', async () => {
    await permissionsCmd(makeCtx(), ['deny', 'Write'])
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.deny).toEqual(['Write'])
    expect(perm.check(writeTool, {})).toBe('ask')
  })

  it('rejects a malformed rule without writing anything', async () => {
    const result = await permissionsCmd(makeCtx(), ['allow', 'Write('])
    expect(result.content).toContain('Invalid rule')
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('rejects an empty rule', async () => {
    const result = await permissionsCmd(makeCtx(), ['allow'])
    expect(result.content).toContain('Missing rule')
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('removes a persisted rule', async () => {
    await permissionsCmd(makeCtx(), ['allow', 'Write'])
    await permissionsCmd(makeCtx(), ['remove', 'Write'])
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow).toEqual([])
    expect(perm.check(writeTool, {})).toBe('ask')
  })

  it('reports when there is nothing to remove', async () => {
    const result = await permissionsCmd(makeCtx(), ['remove', 'Write'])
    expect(result.content).toContain('No rule')
  })

  it('lists persisted rules in the status view', async () => {
    await permissionsCmd(makeCtx(), ['allow', 'Write'])
    const result = await permissionsCmd(makeCtx(), [])
    expect(result.content).toContain('Write')
    expect(result.content).toContain('/permissions allow')
  })

  // ── Mode help must describe the controls that exist ──
  //
  // Both views had drifted: `/setup 5` still listed the retired 3-level
  // `auto`/`ask`/`bypass` spellings and told the user to run
  // `/config permission <level>` — an invocation that has never done anything,
  // since `/config`'s handler takes no arguments. `/permissions` listed five
  // modes under the heading "Switch mode with Shift+Tab" although the wheel
  // reaches four: `bypassPermissions` is legal but not cyclable, so it is listed
  // as a mode and never as a key you can press. Both views now render from one
  // table plus `MODE_CYCLE`, which is what keeps that heading honest.

  it('/permissions lists every mode as a table row and states the wheel separately', async () => {
    const { content } = await permissionsCmd(makeCtx(), [])

    for (const mode of ALL_MODES) {
      // Anchored to a table row, not a bare substring: "auto-runs" inside
      // acceptEdits' description would satisfy `toContain('auto')` by itself.
      expect(content, mode).toMatch(new RegExp(`^ {2}${mode}\\s+— `, 'm'))
    }

    // The heading says "least → most permissive", so the rows must be rendered in
    // `PERMISSION_MODE_HIERARCHY` order — that array is the ranking `clampMode`
    // walks, and the old hand-written list had `default` before `plan`, which
    // inverted the ladder the heading claimed to describe.
    const rows = PERMISSION_MODE_HIERARCHY.map((m) => content.indexOf(`\n  ${m} `))
    expect(rows).not.toContain(-1)
    expect(rows).toEqual([...rows].sort((a, b) => a - b))

    // The wheel is a *separate* set from the legal modes, hence its own line rather
    // than one list doing double duty. Derived from `MODE_CYCLE`, so the line
    // follows the wheel if its membership changes.
    expect(content).toContain(`Shift+Tab cycles: ${MODE_CYCLE.join(' → ')}`)

    expect(content).not.toContain('/config permission')
  })

  it('/setup 5 shows the live mode beside the config value, and no invented schema', async () => {
    const { content } = await setupCmd(makeCtx(), ['5'])

    for (const mode of ALL_MODES) {
      expect(content, mode).toMatch(new RegExp(`^ {2}${mode}\\s+— `, 'm'))
    }
    expect(content).toContain(`Shift+Tab cycles: ${MODE_CYCLE.join(' → ')}`)

    // Two different facts, both shown: `perm` is in `plan` while the config file
    // says `default`. They diverge the moment Shift+Tab is pressed (the wheel is
    // session-only) or the file holds a legacy spelling — reporting only one of
    // them is how the old copy came to call `auto`/`ask`/`bypass` "levels".
    expect(content).toMatch(/Current mode:\s+plan/)
    expect(content).toMatch(/config\.yml:\s+default/)

    // The invented per-tool-category schema lived here. The loader never read it,
    // so following it changed nothing.
    expect(content).not.toContain('file: ask')
    expect(content).not.toContain('/config permission')
  })

  it('/setup 的状态面板报的是引擎所在的档，不是配置文件里的值', async () => {
    // Same divergence as `/setup 5` above, but this panel has one line labelled
    // just "Mode:" — so the line has to name the mode that is refusing calls,
    // not the one written in a file that is only one of the doors.
    const { content } = await setupCmd(makeCtx(), [])

    expect(content).toMatch(/Mode:\s+plan/)
    expect(content).not.toMatch(/Mode:\s+default/)
  })
})

/**
 * The command the denial message tells the user to run has to be a command the
 * command accepts.
 *
 * Nine surfaces print a rule **quoted** — `tool_denied_mode` / `tool_denied_ask_rule`
 * / `tool_denied_classifier` in both locales, this command's usage line, its two
 * status-view examples, and the `config.yml` sample. A slash command's args arrive
 * whitespace-split with the quotes still in them, so as long as the handler read
 * `args[1]` verbatim, `/permissions allow "Git"` answered
 * `Invalid rule ""Git"": not a single tool name.` — the remedy rejected its own
 * spelling. Field report: a session stuck on `Tool "Bash" requires approval under
 * "acceptEdits" mode … /permissions allow "Bash"`, where following the advice was
 * the only thing that could not work.
 */
describe('/permissions — the spelling the CLI advertises', () => {
  let perm: PermissionSystem

  function makeCtx() {
    return {
      engine: {
        getPermission: () => perm,
        getContext: () => ({ getMessages: () => [] }),
        getTools: () => new Map(),
      },
      config: { permission: 'default', providers: [] },
      t: (k: string) => k,
    } as unknown as Parameters<typeof permissionsCmd>[0]
  }

  const allowIn = () =>
    JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow as string[]

  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(join(CWD, '.mipham'), { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(CWD)
    perm = new PermissionSystem('acceptEdits')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(homedir(), { recursive: true, force: true })
  })

  it('accepts the quoted rule the denial message prints', async () => {
    const { content } = await permissionsCmd(makeCtx(), ['allow', '"Bash"'])
    expect(content).not.toContain('Invalid rule')
    expect(allowIn()).toEqual(['Bash'])
  })

  it('takes the command straight out of the denial message and runs it', async () => {
    // Not a hand-copied spelling: the string the user is actually shown, parsed the
    // way the slash-command dispatcher parses it (`split(/\s+/)`, quotes intact).
    const { createT } = await import('../../src/i18n-core/t')
    const enUS = (await import('../../src/i18n-core/locales/en-US.json')).default as TranslationMap
    const t = createT(enUS, enUS)
    const advice = t('errors.tool_denied_mode', { name: 'Git', mode: 'acceptEdits' })
    const quoted = advice.match(/\/permissions allow (\S+)/)?.[1]
    expect(quoted, `no quoted rule in: ${advice}`).toBeDefined()

    const { content } = await permissionsCmd(makeCtx(), ['allow', quoted!])
    expect(content).not.toContain('Invalid rule')
    expect(allowIn()).toEqual(['Git'])
  })

  it('allows two rules given on one line, instead of silently dropping the second', async () => {
    const { content } = await permissionsCmd(makeCtx(), ['allow', '"Git"', '"Bash"'])
    expect(content).not.toContain('Invalid rule')
    expect(allowIn()).toEqual(['Git', 'Bash'])
  })

  it('keeps a rule that carries a space in one piece', async () => {
    // The narrower form the usage line advertises — `"Bash(npm test)"` — reaches the
    // handler as two args; validation must see the one rule, not `Bash(npm`.
    const { content } = await permissionsCmd(makeCtx(), ['allow', '"Bash(npm', 'test)"'])
    expect(content).not.toContain('Invalid rule')
    expect(allowIn()).toEqual(['Bash(npm test)'])
  })

  it('refuses an unbalanced quote without writing anything', async () => {
    const { content } = await permissionsCmd(makeCtx(), ['allow', '"Git'])
    expect(content).toContain('Unbalanced quote')
    expect(existsSync(settingsPath)).toBe(false)
  })

  // ── The fix has to change the ruling, not just the text ──
  it('lifts the real Git tool’s approval under acceptEdits', async () => {
    const { gitTool } = await import('../../src/tools/exec/git')
    const call = { command: 'status --short' }

    // The premise, asserted so the test cannot pass vacuously: under `acceptEdits`
    // the real tool *is* blocked, which is the state the user reported.
    expect(await perm.resolveApproval(gitTool, call)).toMatchObject({ level: 'ask' })

    await permissionsCmd(makeCtx(), ['allow', '"Git"'])

    expect(await perm.resolveApproval(gitTool, call)).toMatchObject({
      level: 'bypass',
      source: 'static',
    })
  })
})
