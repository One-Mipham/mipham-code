import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Isolate the Memory tool from the real ~/.mipham — without this, its tests
// write test-note/alpha/... into the live memory dir and cleanMemDir() rmSync's
// the whole ~/.mipham/memory/ (deleting real memories). Mock homedir so memory
// tests touch only a temp dir.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-agent-tools`,
  }
})
import type { ToolContext } from '../../src/shared'
import { agentTool, resolveRunInBackground } from '../../src/tools/agent/agent'
import { SubAgent } from '../../src/agent/sub-agent'
import { PermissionSystem } from '../../src/core/permission'
import { writeTool } from '../../src/tools/file/write'
import { skillTool } from '../../src/tools/agent/skill'
import { planTool } from '../../src/tools/agent/plan'
import { memoryTool } from '../../src/tools/agent/memory'

// ── Test context ──

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

// ============================================================
// Agent Tool
// ============================================================

describe('Agent tool definition', () => {
  it('has correct metadata', () => {
    expect(agentTool.name).toBe('Agent')
    expect(agentTool.category).toBe('agent')
    expect(agentTool.permission).toBe('self')
  })

  it('requires description and prompt parameters', () => {
    const params = agentTool.parameters as { required: string[] }
    expect(params.required).toEqual(['description', 'prompt'])
  })

  it('has optional subagent_type parameter', () => {
    const params = agentTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('subagent_type')
  })
})

describe('resolveRunInBackground', () => {
  it('defaults to background when unspecified', () => {
    expect(resolveRunInBackground(undefined, undefined)).toBe(true)
  })

  it('honors explicit false (opt-out to sync)', () => {
    expect(resolveRunInBackground(false, undefined)).toBe(false)
  })

  it('honors explicit true', () => {
    expect(resolveRunInBackground(true, undefined)).toBe(true)
  })

  it('honors frontmatter background: false', () => {
    expect(resolveRunInBackground(undefined, { background: false })).toBe(false)
  })

  it('honors frontmatter background: true', () => {
    expect(resolveRunInBackground(undefined, { background: true })).toBe(true)
  })

  it('explicit param wins over frontmatter', () => {
    expect(resolveRunInBackground(false, { background: true })).toBe(false)
    expect(resolveRunInBackground(true, { background: false })).toBe(true)
  })

  /**
   * 一层之下的默认反了 —— `[background-task:<id>]` 是**句柄不是答案**：孩子的结果进后台
   * 注册表与钩子/经验日志，**没有任何东西把它交回**给问它的那个 agent。于是「问一个孩子、
   * 再拿它的回答往下做」在一层之下**根本不成立**：调用方拿到的是占位符。
   * 把这一格默认成后台，就把它从「可选」变成「一个洞」。
   *
   * 但那是**默认**翻转，不是禁止：显式 `run_in_background: true` 两个方向都仍然算数 ——
   * 那是**请求**，不是替调用方选的默认值。
   */
  it('嵌套调用缺省时落到同步（默认翻转，不是禁止后台）', () => {
    expect(resolveRunInBackground(undefined, undefined, true)).toBe(false)
  })

  it('嵌套调用里显式 true 仍算数（请求优先于默认值）', () => {
    expect(resolveRunInBackground(true, undefined, true)).toBe(true)
  })

  it('嵌套调用里显式 false 仍是 false', () => {
    expect(resolveRunInBackground(false, undefined, true)).toBe(false)
  })

  /**
   * 嵌套规则压在 frontmatter **之上**：一个「默认给自己装成后台」的 agent 定义，被另一个
   * sub-agent 调用时不能把这个洞带下去 —— 否则同一份 frontmatter 在顶层无害、在一层之下
   * 就把调用方的输入换成占位符。
   */
  it('嵌套调用压过 frontmatter 的 background: true', () => {
    expect(resolveRunInBackground(undefined, { background: true }, true)).toBe(false)
  })

  it('嵌套调用压过 frontmatter 的 background: false（同向）', () => {
    expect(resolveRunInBackground(undefined, { background: false }, true)).toBe(false)
  })
})

describe('Agent tool execution', () => {
  it('returns error when no provider registry is available', async () => {
    const result = await agentTool.execute(
      { description: 'Review code', prompt: 'Find bugs in src/' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('provider')
  })

  it('returns error for explore type without provider', async () => {
    const result = await agentTool.execute(
      { description: 'Test', prompt: 'Search for patterns', subagent_type: 'explore' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('provider')
  })

  it('rejects invalid subagent_type', async () => {
    const result = await agentTool.execute(
      { description: 'Test', prompt: 'Test', subagent_type: 'invalid_type' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid subagent_type')
  })

  /**
   * `resolveRunInBackground` 的嵌套规则单独测过，但那只是**尺子**：这里钉的是尺子**接上了**
   * —— 同一个 `Agent` 工具、同一份参数，`ctx.isSubAgent` 一个为真一个为假，交给 `SubAgent`
   * 的 `runInBackground` 必须跟着变。少了这一条，把第三个实参从调用点删掉（签名有默认值
   * `false`，不会报错）时全绿。
   */
  it('把 ctx.isSubAgent 传进后台默认值的裁决（子代理默认同步、顶层默认后台）', async () => {
    const seen: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(SubAgent.prototype, 'execute').mockImplementation((async (
      _prompt: string,
      _desc: string,
      opts: Record<string, unknown>,
    ) => {
      seen.push(opts)
      return 'done'
    }) as never)

    const ready = {
      ...ctx,
      registry: {} as never,
      toolRegistry: new Map() as never,
    }

    try {
      await agentTool.execute(
        { description: 'child', prompt: 'go' },
        { ...ready, isSubAgent: true },
      )
      await agentTool.execute({ description: 'child', prompt: 'go' }, ready)
    } finally {
      spy.mockRestore()
    }

    expect(seen[0]!.runInBackground).toBe(false)
    expect(seen[1]!.runInBackground).toBe(true)
  })
})

// ============================================================
// Agent 工具的 reasoning effort
//
// 档位唯一的作用是**缩放流式空闲超时**（`providers/fetch-utils.ts` 的
// `streamIdleTimeoutMs`：high 2×、xhigh 3×、max 4×）。认不出的档位与「没给」
// 在那边是同一条路（1× 基数），所以不认识的取值绝不能静默通过 —— 那会让调用方
// 以为生效了，实际拿着默认预算。这里钉两件事：参数到了子代理手上，以及畸形值在
// 构造子代理之前就被拒。
// ============================================================

describe('Agent tool — effort 透传', () => {
  const ready = () => ({ ...ctx, registry: {} as never, toolRegistry: new Map() as never })

  it('声明的档位原样进 SubAgent 选项', async () => {
    const seen: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(SubAgent.prototype, 'execute').mockImplementation((async (
      _prompt: string,
      _desc: string,
      opts: Record<string, unknown>,
    ) => {
      seen.push(opts)
      return 'done'
    }) as never)

    try {
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        await agentTool.execute({ description: 'child', prompt: 'go', effort }, ready())
      }
      await agentTool.execute({ description: 'child', prompt: 'go' }, ready())
    } finally {
      spy.mockRestore()
    }

    expect(seen.map((o) => o.effort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      undefined, // 没给就是没给 —— 不是被默认成 'high'
    ])
  })

  it('畸形档位在派发前被拒，且子代理根本没被构造', async () => {
    const spy = vi.spyOn(SubAgent.prototype, 'execute')

    let result: Awaited<ReturnType<typeof agentTool.execute>>
    try {
      result = await agentTool.execute(
        { description: 'child', prompt: 'go', effort: 'ludicrous' },
        ready(),
      )
    } finally {
      spy.mockRestore()
    }

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid effort')
    expect(spy).not.toHaveBeenCalled()
  })

  it('正对照：不带 effort 时同一个调用确实走得通', async () => {
    // 没有这一条，「一律拒绝」也能让上一条变绿。
    const spy = vi.spyOn(SubAgent.prototype, 'execute').mockResolvedValue('done' as never)
    let ok: boolean
    try {
      const r = await agentTool.execute({ description: 'child', prompt: 'go' }, ready())
      ok = r.success
    } finally {
      spy.mockRestore()
    }
    expect(ok).toBe(true)
  })
})

// ============================================================
// Agent 派发闸
// ============================================================

/**
 * `permission` 字段只是一张标签；真正的闸在 `PermissionSystem` 的解析链上
 * （`default` 档走到第 6 步 `tool.permission`）。所以这里问**真对象**、真档位，
 * 而不是读那个字符串 —— 字段改成 `'self'` 却被解析链吃掉，读字段也照样绿。
 */
describe('Agent 派发闸（手动模式下可达）', () => {
  it('default 模式下派发**不是** ask —— 手动模式也能 fan-out', () => {
    const ps = new PermissionSystem('default')
    expect(ps.check(agentTool, { description: 'x', prompt: 'y' })).not.toBe('ask')
  })

  /**
   * 正对照：同一档位下 `Write` 仍是 `'ask'`。没有这一条，「只放开派发」与
   * 「把整档放开」在屏幕上同形 —— 而这两件事的安全含义正好相反。
   */
  it('正对照：同一档位下 Write 仍是 ask —— 放开的是派发，不是整档', () => {
    const ps = new PermissionSystem('default')
    expect(ps.check(writeTool, { file_path: '/tmp/x' })).toBe('ask')
  })

  /**
   * 上面第一条的前提是「派发闸与子代理自己的闸是**重复**的」：子代理仍用它自己那套
   * 权限系统拦每一次工具调用（`sub-agent.ts` 的 `permission: subPermission`）。
   * 这里把**构造实参**钉死 —— 从原型方法里读实例的私有字段 `permission`，就是
   * `new SubAgent(..., ctx.permissionSystem, ...)` 的第三个实参本身。
   * 它换成 `undefined` 或一个新建的 PermissionSystem 时这一条会红，而那正是
   * 「派发闸不再是重复闸」的那一刻。
   */
  it('子代理拿到的就是父级那一个 permissionSystem —— 重复闸的另一半', async () => {
    const parentPermission = new PermissionSystem('default')
    const seen: Array<{ toolContext?: unknown; permission?: unknown }> = []
    const spy = vi.spyOn(SubAgent.prototype, 'execute').mockImplementation(function (
      this: SubAgent,
      _prompt: string,
      _desc: string,
      opts: { toolContext?: unknown },
    ) {
      seen.push({
        toolContext: opts.toolContext,
        permission: (this as unknown as { permission?: unknown }).permission,
      })
      return Promise.resolve('done')
    } as never)

    try {
      await agentTool.execute(
        { description: 'child', prompt: 'go' },
        {
          ...ctx,
          registry: {} as never,
          toolRegistry: new Map() as never,
          permissionSystem: parentPermission,
        },
      )
    } finally {
      spy.mockRestore()
    }

    expect(seen[0]!.permission).toBe(parentPermission)
  })
})

// ============================================================
// Skill Tool
// ============================================================

describe('Skill tool definition', () => {
  it('has correct metadata', () => {
    expect(skillTool.name).toBe('Skill')
    expect(skillTool.category).toBe('agent')
    expect(skillTool.permission).toBe('self')
  })

  it('requires skill parameter', () => {
    const params = skillTool.parameters as { required: string[] }
    expect(params.required).toEqual(['skill'])
  })

  it('has optional args parameter', () => {
    const params = skillTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('args')
  })
})

describe('Skill tool execution', () => {
  it('returns error when SkillsLoader is not in context', async () => {
    const result = await skillTool.execute({ skill: 'code-reviewer' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('SkillsLoader')
  })

  it('shows available skills in error message', async () => {
    const result = await skillTool.execute({ skill: 'nonexistent-skill' }, ctx)
    expect(result.error).toContain('SKILL.md')
  })

  it('includes args in response when available', async () => {
    const result = await skillTool.execute({ skill: 'searcher', args: '--deep' }, ctx)
    // Without SkillsLoader, returns error
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Plan Tool
// ============================================================

describe('Plan tool definition', () => {
  it('has correct metadata', () => {
    expect(planTool.name).toBe('Plan')
    expect(planTool.category).toBe('agent')
    expect(planTool.permission).toBe('self')
  })

  it('has empty required parameters', () => {
    const params = planTool.parameters as { required?: string[] }
    expect(params.required || []).toEqual([])
  })
})

describe('Plan tool execution', () => {
  it('activates plan mode and creates plan file', async () => {
    const result = await planTool.execute({ title: 'Test Plan' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('Plan Mode Activated')
    expect(result.content).toContain('.mipham/plans/plan-')
  })

  it('creates plan file on disk', async () => {
    const result = await planTool.execute({ title: 'Disk Test' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('Plan file:')
  })
})

// ============================================================
// Memory Tool
// ============================================================

describe('Memory tool definition', () => {
  it('has correct metadata', () => {
    expect(memoryTool.name).toBe('Memory')
    expect(memoryTool.category).toBe('agent')
    expect(memoryTool.permission).toBe('self')
  })

  it('requires action parameter', () => {
    const params = memoryTool.parameters as { required: string[] }
    expect(params.required).toEqual(['action'])
  })

  it('accepts action enum: read, write, list, search', () => {
    const params = memoryTool.parameters as { properties: Record<string, unknown> }
    const action = params.properties.action as { enum: string[] }
    expect(action.enum).toEqual(['read', 'write', 'list', 'search'])
  })
})

describe('Memory tool execution', () => {
  const MEM_DIR = join(homedir(), '.mipham', 'memory')

  function cleanMemDir() {
    try {
      rmSync(MEM_DIR, { recursive: true, force: true })
    } catch {
      /* ok */
    }
  }

  beforeEach(() => {
    cleanMemDir()
  })

  afterEach(() => {
    cleanMemDir()
  })

  it('writes a memory', async () => {
    const result = await memoryTool.execute(
      { action: 'write', name: 'test-note', content: '# Hello\n\nThis is a note.' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('Memory "test-note" written')
  })

  it('reads a memory that exists', async () => {
    await memoryTool.execute(
      { action: 'write', name: 'readable', content: 'readable content' },
      ctx,
    )

    const result = await memoryTool.execute({ action: 'read', name: 'readable' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('readable content')
  })

  it('errors when reading non-existent memory', async () => {
    const result = await memoryTool.execute({ action: 'read', name: 'nonexistent' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('lists all memories', async () => {
    await memoryTool.execute({ action: 'write', name: 'alpha', content: 'a' }, ctx)
    await memoryTool.execute({ action: 'write', name: 'beta', content: 'b' }, ctx)

    const result = await memoryTool.execute({ action: 'list' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('alpha.md')
    expect(result.content).toContain('beta.md')
  })

  it('returns (no memories) for empty directory', async () => {
    const result = await memoryTool.execute({ action: 'list' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toBe('(no memories)')
  })

  it('errors when name is missing for read', async () => {
    const result = await memoryTool.execute({ action: 'read' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('name is required')
  })

  it('errors when name is missing for write', async () => {
    const result = await memoryTool.execute({ action: 'write', content: 'stuff' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('name is required')
  })

  it('errors for unknown action (when name is provided)', async () => {
    const result = await memoryTool.execute({ action: 'delete', name: 'some-name' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown action')
  })

  it('overwrites existing memory', async () => {
    await memoryTool.execute({ action: 'write', name: 'overwrite', content: 'original' }, ctx)
    await memoryTool.execute({ action: 'write', name: 'overwrite', content: 'updated' }, ctx)
    const result = await memoryTool.execute({ action: 'read', name: 'overwrite' }, ctx)
    expect(result.content).toContain('updated')
  })
})
