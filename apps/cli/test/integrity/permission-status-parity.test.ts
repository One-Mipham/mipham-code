/**
 * P3 + P5 — 状态（页脚 / 系统提示）与执行必须**同源**，这一条只能从源码侧断。
 *
 * 两处缺陷的形状相同：**读的是「近似的替身」，不是真对象** ——
 * - P5：系统提示拿到的是 `config.permission` 这个**原始配置值**。它可能根本不是合法模式
 *   （`bypass` / `auto` / `ask` / 错拼），此时 `buildPermissionContext` 返回空串 ⇒ 提示里
 *   **一个字都不提权限**；而即使拼写合法，组织级限制也会把实际模式钳到别处 ⇒ 模型被告知
 *   的模式与它真正被允许做的事不一致，且偏差方向**偏宽**。
 * - P3：页脚那一行读的是本地的 `useState`，初始值写死 `'default'`、循环后存请求值。
 *
 * 两者的**行为**用例（`test/core/permission.test.ts`、`test/ui/permission-mode.test.ts`）
 * 都测不到「调用点用的是哪个值」—— 把真对象算对了、却仍把替身传进去，行为用例全绿。
 * 故这里断**调用点本身**：两处组装点必须把 live 权限系统的模式交给 `buildSystemPrompt`，
 * 页脚的两个入口必须回读 live 系统。判据是「负锚在场即红」，不是「读起来像对的」。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 同 `permission-warning-channels.test.ts`：锚定包目录（`apps/cli/`）。 */
const CLI_DIR = join(import.meta.dirname, '..', '..')

const read = (rel: string): string => readFileSync(join(CLI_DIR, rel), 'utf8')

const INDEX = read('src/index.tsx')
const APP = read('src/ui/app.tsx')

describe('状态与执行同源（P3 / P5）', () => {
  it('正对照：两个文件确实读到了内容（否则下面的断言是空集上的空话）', () => {
    expect(INDEX).toContain('new QueryEngine(')
    expect(APP).toContain('onCyclePermission')
  })

  it('P5：两处系统提示组装点都拿到 live 权限系统的模式，而不是 config 的原始值', () => {
    // 恰好两处：`--resume` 那条进路与全新会话那条 —— 只接一个，另一个进路上的模型
    // 仍然收到原始值（与 P1 的「两条通道」同形）。
    const arg = /buildSystemPrompt\(permission\.getMode\(\)\)/g
    expect(INDEX.match(arg)?.length).toBe(2)
    // 负锚：原始配置值不得再直接进提示
    expect(INDEX).not.toMatch(/buildSystemPrompt\(config\.permission/)
  })

  it('P3：页脚的两个入口都回读 live 系统，而不是本地猜的值', () => {
    // 初始值：不得再用字面量初始化（写死的 'default' 正是本项要关掉的形状）
    expect(APP).not.toMatch(/useState<PermissionMode>\(\s*'/)
    // 循环：必须把**读回的值**作为结果，而不是请求的那一档
    expect(APP).toMatch(/cyclePermissionMode\(engine\.getPermission\(\)/)
  })
})
