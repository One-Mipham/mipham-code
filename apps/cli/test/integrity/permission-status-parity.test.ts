/**
 * P3 + P5 — 状态（页脚 / 系统提示）与执行必须**同源**，这一条只能从源码侧断。
 *
 * 两处缺陷的形状相同：**读的是「近似的替身」，不是真对象** ——
 * - P5：系统提示拿到的是 `config.permission` 这个**原始配置值**。它可能根本不是合法模式
 *   （`bypass` / `ask` / 错拼），此时 `buildPermissionBlock` 返回空串 ⇒ 提示里**一个字都
 *   不提权限**；而即使拼写合法，组织级限制也会把实际模式钳到别处 ⇒ 模型被告知的模式与它
 *   真正被允许做的事不一致，且偏差方向**偏宽**。
 *   **2026-09-23 的第二形态**：修好「读哪个值」之后，剩下的缺口是「**什么时候**读」——
 *   模式是在组装提示那一刻采样的，于是 Shift+Tab 切档后模型仍读着旧指令。往窄切是自纠正的
 *   （模型比闸门更保守），**往宽切**则让它拒绝做已经允许的事。修法是取消采样：权限段改由
 *   `ContextManager` 读时派生（接线点是 `setPermissionContextSource`），两处组装点不再带模式。
 * - P3：页脚那一行读的是本地的 `useState`，初始值写死 `'default'`、循环后存请求值。
 *
 * 两者的**行为**用例（`test/core/permission.test.ts`、`test/ui/permission-mode.test.ts`）
 * 都测不到「调用点用的是哪个值」—— 把真对象算对了、却仍把替身传进去，行为用例全绿。
 * 故这里断**调用点本身**：权限段的唯一施加点必须接 live 权限系统、且不得有人把模式烘进提示，
 * 页脚的两个入口必须回读 live 系统。判据是「负锚在场即红」，不是「读起来像对的」。
 *
 * 第三组（`auto` 档分类器的接线）形状相同而更极端：`src/index.tsx` **不在任何行为
 * 用例的覆盖里**。删掉那一行 `permission.setClassifier(`，typecheck / lint / 全量测试
 * 全绿，而 `auto` 档退回「每一次被门控的调用都拒」—— `core/rules-loader.ts` 那次
 * 「有定义、无施加点」的复刻。故与 P3/P5 同处一室。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 同 `permission-warning-channels.test.ts`：锚定包目录（`apps/cli/`）。 */
const CLI_DIR = join(import.meta.dirname, '..', '..')

const read = (rel: string): string => readFileSync(join(CLI_DIR, rel), 'utf8')

/** 只剥注释。**已知边界**：不剥字符串字面量 —— 故下面的锚一律写全「接收者.方法(」，
 *  单个词（`resolveApproval`）谁都可能在散文或消息串里写出来，全形不像。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const INDEX = read('src/index.tsx')
const APP = read('src/ui/app.tsx')
const ENGINE = stripComments(read('src/core/engine.ts'))
const SUB_AGENT = stripComments(read('src/agent/sub-agent.ts'))
const INDEX_CODE = stripComments(INDEX)

describe('状态与执行同源（P3 / P5）', () => {
  it('正对照：两个文件确实读到了内容（否则下面的断言是空集上的空话）', () => {
    expect(INDEX).toContain('new QueryEngine(')
    expect(APP).toContain('onCyclePermission')
  })

  it('P5：权限段读时派生 —— 接到 live 权限系统上，且没有任何地方把模式烘进提示', () => {
    // 施加点唯一：`ContextManager.setPermissionContextSource`。删掉这一行，系统提示里就
    // 一个字都不提权限（静默、全绿）—— 与上面 `setClassifier` 那次「有定义、无施加点」同形。
    // 交给它的必须是 live `permission.getMode()`，不是 `config.permission` 那个原始值：
    // 组织级限制会静默改写它，偏差方向还是「报得比实际宽」。
    expect(INDEX_CODE, 'index.tsx 没有把权限段接到 live 权限系统上').toMatch(
      /setPermissionContextSource\([\s\S]{0,80}?buildPermissionBlock\(permission\.getMode\(\)\)/,
    )
    // 负锚一：原始配置值不得进提示
    expect(INDEX).not.toMatch(/buildSystemPrompt\(config\.permission/)
    // 负锚二：**任何地方都不得再把模式烘进提示**。烘进去的那份是模式的一份拷贝，会话中途
    // 切档后它与执行分叉：往宽切时闸门开了、模型仍读着旧指令去拒绝已允许的事（本条要关掉的
    // 形状）；往窄切是自纠正的，所以旧形状只在一半方向上咬人、更难被发现。
    expect(INDEX).not.toMatch(/buildSystemPrompt\(permission\.getMode\(\)\)/)
    expect(INDEX).not.toMatch(/buildSystemPrompt\(\s*['"`]/)
    expect(INDEX, '两处组装点都必须是不带参数的 buildSystemPrompt()').toMatch(
      /buildSystemPrompt\(\)/,
    )
  })

  it('P3：页脚的两个入口都回读 live 系统，而不是本地猜的值', () => {
    // 初始值：不得再用字面量初始化（写死的 'default' 正是本项要关掉的形状）
    expect(APP).not.toMatch(/useState<PermissionMode>\(\s*'/)
    // 循环：必须把**读回的值**作为结果，而不是请求的那一档
    expect(APP).toMatch(/cyclePermissionMode\(engine\.getPermission\(\)/)
  })

  it('P3b：页脚字形按档取，不是写死的 `⏵⏵`', () => {
    // 决策 9 的另一半（`default` 那一档 CC 什么都不显示）。映射本身由
    // `test/ui/permission-mode.test.ts` 钉住，这里断的是**接线**：把字形写回 JSX 字面量，
    // 那张表就成了「有定义、无施加点」—— 而且缺陷全绿：`default` 档会显示一个它并不具备的
    // 「自动接受」字形，读到的权限比实际宽，与 P3 同族。
    expect(APP).not.toMatch(/⏵⏵ \{PERMISSION_LABELS/)
    expect(APP).toMatch(/permissionGlyphPrefix\(permissionMode\)/)
  })
})

describe('`auto` 档分类器的接线（三个点，缺一处就是「实现了但从不生效」）', () => {
  it('剥离器真的在做事（剥不掉注释的话，下面三条都是空的）', () => {
    const fake = [
      'const a = 1 // gate.resolveApproval(tool, input)',
      '/* this.permission.resolveApproval(a, b) */',
      'const b = 2',
    ].join('\n')
    expect(stripComments(fake)).not.toContain('resolveApproval')
    expect(stripComments(fake)).toContain('const b = 2')
  })

  it('两个闸门都在 `await …resolveApproval(` 上，且不再走同步的 `needsApproval(`', () => {
    // 闸门问的必须是完整裁决（`ApprovalDecision`），不是布尔 —— 两个调用点都要
    // 用它区分「策略拒绝」与「分类器不可达」，而 `needsApproval()` 只有 true/false。
    // 漏一个 `await` 则是 lint 的 `no-floating-promises`（error 档）—— 这里再加一道。
    for (const [name, src, anchor] of [
      ['engine.ts', ENGINE, /await this\.permission\.resolveApproval\(/],
      ['sub-agent.ts', SUB_AGENT, /await gate\.resolveApproval\(/],
    ] as const) {
      expect(src, `${name}: 闸门没有走 resolveApproval ⇒ 分类器永不生效`).toMatch(anchor)
      expect(src, `${name}: 闸门还留着同步的 needsApproval(`).not.toContain('needsApproval(')
    }
  })

  it('分类器在启动时挂到 live 权限系统上（这一行没有任何行为用例看得见）', () => {
    expect(INDEX_CODE, 'index.tsx 没有构造分类器').toContain('new LlmPermissionClassifier(')
    expect(INDEX_CODE, 'index.tsx 没有把它挂上去').toMatch(/permission\.setClassifier\(/)

    // 挂上去的必须挂在 `PermissionSystem` 上（`index.tsx` 里那个 live 对象）。
    // 挂到别处（比如给 engine 加一个 setter）会让 daemon 对等守卫要么被迫同步接、
    // 要么被迫写具名豁免 —— 那条守卫**看不见**这一行，所以由这里来断。
    expect(INDEX_CODE).toMatch(/permission\.setClassifier\(\s*\n?\s*new LlmPermissionClassifier\(/)

    // 模型必须在**裁决时**取：冻成字符串会让「用户切到便宜模型」继续按老模型计费，
    // 且界面上没有任何东西会说这件事。
    const ctor = /new LlmPermissionClassifier\(([\s\S]*?)\)\n/.exec(INDEX_CODE)
    expect(ctor, '没抓到构造参数，下面的断言会变成空话').not.toBeNull()
    expect(ctor![1], '模型参数不是个 thunk ⇒ 启动时就被冻住').toContain('=>')
    expect(ctor![1]).toContain('getActiveModel()')
    expect(ctor![1], 'resolveModel 又被写成了字面量').not.toMatch(/resolveModel:\s*['"`]/)
  })
})
