import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../../../src/shared'
import { exitPlanModeTool } from '../../../src/tools/agent/exit-plan'

// ============================================================
// `planFile` 的**文档承诺**是「省略则用最近一份计划文件」，而执行体从前是
// `(params.planFile as string) || ''` —— 承诺的兜底是死代码。于是「省略」这个写法
// 读起来像「用最近那份」，实际产出一条**没有计划**的退出：模型于是凭自己的上下文
// 讲一份**它从没取回**的计划，而结果文本还无条件写着「✓ Plan file saved」。
//
// 三种状态各自要能**分开读到**（读了 / 有路径但读不了 / 根本没有），因为把
// 「没找到」显示成「已保存」正是这条缺口的表现形式。
// ============================================================

const ctxIn = (cwd: string): ToolContext => ({
  cwd,
  sessionId: 'test',
  provider: 'test',
  model: 'test-model',
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mipham-exit-plan-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 在 `<cwd>/.mipham/plans/` 下放一份计划，并给它一个人为的 mtime。 */
function planFile(name: string, body: string, mtimeSeconds: number): string {
  const plansDir = join(dir, '.mipham', 'plans')
  mkdirSync(plansDir, { recursive: true })
  const path = join(plansDir, name)
  writeFileSync(path, body)
  utimesSync(path, mtimeSeconds, mtimeSeconds)
  return path
}

const run = (params: Record<string, unknown>) => exitPlanModeTool.execute(params, ctxIn(dir))

describe('ExitPlanMode：显式 planFile', () => {
  it('给了路径就读它，内容出现在结果里', async () => {
    const path = join(dir, 'my-plan.md')
    writeFileSync(path, 'STEP-ONE: 先做这个')

    const r = await run({ planFile: path })

    expect(r.success).toBe(true)
    expect(r.content).toContain('STEP-ONE: 先做这个')
    expect(r.content).toContain('Plan file read')
    expect(r.content).toContain(`Plan file: ${path}`)
  })

  it('给了路径但读不到 ⇒ 报出路径与原因，不假装「已保存」', async () => {
    const missing = join(dir, 'nope.md')

    const r = await run({ planFile: missing })

    expect(r.success).toBe(true) // 退出计划模式本身仍然成功
    expect(r.content).not.toContain('Plan file read')
    expect(r.content).toContain('not readable')
    expect(r.content).toContain(missing)
  })
})

describe('ExitPlanMode：省略 planFile 时用最近一份计划（文档承诺的兜底）', () => {
  it('唯一一份计划被自动取用', async () => {
    const path = planFile('plan-a.md', 'ONLY-PLAN-BODY', 1_700_000_000)

    const r = await run({})

    expect(r.content).toContain('ONLY-PLAN-BODY')
    expect(r.content).toContain('Plan file read')
    expect(r.content).toContain(path)
  })

  it('多份时取 **mtime 最新**那份（不是名字序、也不是目录序）', async () => {
    // 名字故意与新旧相反：`plan-a` 更新。按名字序会选错。
    planFile('plan-a.md', 'NEWEST-BODY', 1_700_000_500)
    planFile('plan-z.md', 'OLDEST-BODY', 1_700_000_000)

    const r = await run({})

    expect(r.content).toContain('NEWEST-BODY')
    expect(r.content).not.toContain('OLDEST-BODY')
  })

  it('只认 `plan-*.md`：隔壁名字的 markdown 不参与', async () => {
    // 目录里有别的东西，且它更新 —— 若只按「目录里最新的 md」找，会选中它。
    const plansDir = join(dir, '.mipham', 'plans')
    mkdirSync(plansDir, { recursive: true })
    const decoy = join(plansDir, 'notes.md')
    writeFileSync(decoy, 'DECOY-NOT-A-PLAN')
    utimesSync(decoy, 1_700_000_999, 1_700_000_999)
    planFile('plan-real.md', 'REAL-PLAN-BODY', 1_700_000_000)

    const r = await run({})

    expect(r.content).toContain('REAL-PLAN-BODY')
    expect(r.content).not.toContain('DECOY-NOT-A-PLAN')
  })

  it('没有 plans 目录 ⇒ 明说「没找到」，不装作读了', async () => {
    const r = await run({})

    expect(r.success).toBe(true)
    expect(r.content).not.toContain('Plan file read')
    expect(r.content).toContain('No plan file found')
  })

  it('显式路径压过兜底（给了路径时不去看 plans 目录）', async () => {
    planFile('plan-newest.md', 'FALLBACK-BODY', 1_700_000_999)
    const explicit = join(dir, 'explicit.md')
    writeFileSync(explicit, 'EXPLICIT-BODY')

    const r = await run({ planFile: explicit })

    expect(r.content).toContain('EXPLICIT-BODY')
    expect(r.content).not.toContain('FALLBACK-BODY')
  })
})
