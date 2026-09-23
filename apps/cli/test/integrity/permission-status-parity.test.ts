/**
 * P3 + P5 + P6 — 状态（页脚 / 系统提示）与执行必须**同源**，这一条只能从源码侧断。
 *
 * 三处缺陷的形状相同：**读的是「近似的替身」，不是真对象** ——
 * - P5：系统提示拿到的是 `config.permission` 这个**原始配置值**。它可能根本不是合法模式
 *   （`bypass` / `ask` / 错拼），此时 `buildPermissionBlock` 返回空串 ⇒ 提示里**一个字都
 *   不提权限**；而即使拼写合法，组织级限制也会把实际模式钳到别处 ⇒ 模型被告知的模式与它
 *   真正被允许做的事不一致，且偏差方向**偏宽**。
 *   **2026-09-23 的第二形态**：修好「读哪个值」之后，剩下的缺口是「**什么时候**读」——
 *   模式是在组装提示那一刻采样的，于是 Shift+Tab 切档后模型仍读着旧指令。往窄切是自纠正的
 *   （模型比闸门更保守），**往宽切**则让它拒绝做已经允许的事。修法是取消采样：权限段改由
 *   `ContextManager` 读时派生（接线点是 `setPermissionContextSource`），两处组装点不再带模式。
 * - P6：子代理的系统提示里从来没有权限段 —— `sub-agent.ts` 拼的是自己那一份，与上下文的
 *   系统提示是**两份**，于是它对当前档一无所知。它要报的是**自己的**档（定义写
 *   `permissionMode: 'inherit'` 时那才等于父档，由 `createSubAgentPermission` 解析）。
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
 *
 * P7（`mipham attach` 切档）同族，但**缺口在网的对面**：页脚在本地、闸门在 daemon 上，
 * `set_mode` 之前一个字都不过网 ⇒「Shift+Tab 按了、页脚走了、而 daemon 照旧」。客户端
 * 那一半已由 `test/daemon/remote-engine.test.ts` 从**帧序列**上断死（顺序、内容、
 * 不钉不该钉的档）；这里断的是行为用例**够不到**的两处：daemon 的 WS 分发（在
 * `createServer` 的闭包里，而测试环境的 `upgrade()` 恒返回 false ⇒ 帧永远进不去）与
 * 引擎重建时的档位来源。另加一条跨进程**契约**守卫：协议两侧各写各的字面量，
 * 拼错一处就是「每帧都被 `default: break` 静默丢掉」，与遥测那条契约漂移同形。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_MODES } from '../../src/core/permission-config'
import { DAEMON_PERMISSION_MODES } from '../../src/daemon/server'

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
const SERVER = stripComments(read('src/daemon/server.ts'))
const PROTOCOL = read('src/daemon/attach-protocol.ts')

/**
 * 取出 `case '<name>': { … }` 分支的正文（按花括号配平，不看缩进 —— 缩进锚会在
 * prettier 重排整段时假红）。
 */
function caseBody(src: string, name: string): string | null {
  const start = src.indexOf(`case '${name}': {`)
  if (start === -1) return null
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

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

  it('P6：子代理报自己的档 —— 权限段落在**真正发出去**的那份提示上', () => {
    // 子代理的请求读的是本文件里的局部变量 `currentSystemPrompt`，**从不读上下文**的
    // 系统提示（那是引擎的行为）。所以权限段只能加在那里：挂在
    // `ContextManager.setPermissionContextSource` 上会是一处**装饰** —— 接线在场、请求里
    // 一个字都到不了。行为用例（`test/agent/sub-agent-permission-prompt.test.ts`）断的是
    // 发出去的那份，看不见「接线接在哪个对象上」，故这一半在这里断。
    expect(SUB_AGENT, '子代理的权限段没有接在闸门上').toMatch(
      /buildPermissionBlock\(gate\.getMode\(\)\)/,
    )
    // 负锚一：不得改读父系统 —— 定义指名了自己那一档时，父档不是它的档。
    expect(SUB_AGENT, '报的是父档 ⇒ 与 P5 同族：模型拿到的权限说明不是它的').not.toMatch(
      /buildPermissionBlock\(this\.permission/,
    )
    // 负锚二：不得把模式烘成字面量 —— 换一档就静默说谎，且没有行为用例看得见。
    expect(SUB_AGENT).not.toMatch(/buildPermissionBlock\(\s*['"`]/)
    // 负锚三：不得改挂到上下文那条读时缝上 —— 这是一个**实测过的**假修法：接线在场、
    // 上面那条正锚也照样命中，但请求读的是局部变量，线上一个字都收不到
    // （负控 NC4：5 条行为用例全红，而只断「调用在不在」的守卫**放它过去**）。
    expect(SUB_AGENT, '挂在上下文上是装饰 —— 子代理的请求从不读上下文').not.toContain(
      'setPermissionContextSource',
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

describe('P7 — `mipham attach` 切档过网（页脚在本地、闸门在 daemon）', () => {
  it('提取器真的在做事（配平失败的话下面几条断的是空串）', () => {
    const fake =
      "switch (t) {\n  case 'a': {\n    if (x) { y() }\n    break\n  }\n  case 'b': break\n}"
    const body = caseBody(fake, 'a')
    expect(body).toContain('y()')
    expect(body).not.toContain("case 'b'")
    expect(caseBody(fake, 'zzz')).toBeNull()
  })

  it('P7a：协议两侧说的是同一种消息（各写各的字面量 ⇒ 漂移后每帧被静默丢掉）', () => {
    // daemon 的分发末尾是 `default: break`，客户端拼错一个字母就是「没有任何回音」——
    // 与遥测那条「契约漂移 ⇒ 每个事件 404 ⇒ 静默全丢」同形，且更难看到。
    expect(PROTOCOL, '协议里没有 set_mode').toContain("type: 'set_mode'")
    expect(PROTOCOL, 'session_state 没带档位 ⇒ 新 attach 的客户端只能猜 default').toMatch(
      /ServerSessionStateMessage[\s\S]{0,220}?mode: PermissionMode/,
    )
    expect(read('src/daemon/remote-engine.ts'), '客户端没有发 set_mode').toContain(
      "type: 'set_mode'",
    )
    expect(caseBody(SERVER, 'set_mode'), 'daemon 不认这个类型').not.toBeNull()
  })

  it('P7b：daemon 施加到 live 闸门，回播**生效**档，不认的值 fail-closed', () => {
    const body = caseBody(SERVER, 'set_mode')
    expect(body, '没抓到 case 体，下面全是空话').not.toBeNull()
    const src = body!

    // 值来自不可信输入（另一个进程的字节），必须先过白名单再施加
    expect(src, '没有校验就施加 ⇒ 一个 attach 能往闸门里塞任意字符串').toMatch(
      /DAEMON_PERMISSION_MODES\.has\(/,
    )
    // 施加点必须是 worker（它拿到的是引擎手里那个 live PermissionSystem）
    expect(src, '没有改到会话的闸门').toMatch(/worker\.setPermissionMode\(/)
    // 回播的必须是**生效**值：报请求值就是那条老缺陷的形状 —— 说放行、实际审批
    expect(src, '回播的不是生效值').toMatch(/mode: effective/)
    expect(src, '回播了请求值').not.toMatch(/mode: (requested|raw)\b/)
    // 会话身份取自 socket，绝不取自 payload —— 否则一个 attach 能改**别的**会话的闸门
    expect(src, '用了 payload 里的 sessionId').not.toMatch(/parsed\.sessionId/)
  })

  it('P7c：worker 被空闲回收后重建，档位不静默退回 env', () => {
    // 引擎不是永久的：`WorkerPool` 会回收空闲 worker，下一次 prompt 从
    // `resolveDaemonPermission()`（env）重建 —— 页脚还停在用户选的那一档，而闸门已经
    // 悄悄换了方向（往宽、往窄都是错，且没有任何东西会说出口）。
    expect(SERVER, '重建引擎时没有恢复用户选过的档').toMatch(
      /sessionModes\.get\(sessionId\)[\s\S]{0,80}?permission\.setMode\(/,
    )
  })

  it('P7d：页脚订阅 daemon 的答复（钳制在那边发生，答复是异步来的）', () => {
    // `App` 不在任何行为用例的覆盖里（没有任何测试渲染它），而言论侧唯一能看见的
    // 就是这一行。少了它：钳制发生时页脚永远停在请求的那一档。
    expect(APP, '页脚没有订阅 daemon 的档位答复').toMatch(
      /onPermissionModeChange\([\s\S]{0,40}?setPermissionMode\(/,
    )
    expect(APP, '没有做能力判别 ⇒ 本地引擎上没有这个方法').toContain(
      "'onPermissionModeChange' in engine",
    )
    expect(stripComments(read('src/daemon/remote-engine.ts')), 'RemoteEngine 没有这条订阅').toMatch(
      /onPermissionModeChange\(/,
    )
  })

  it('P7e：daemon 的白名单不是手抄的第二份表（drift 即「env 收、set_mode 放」）', () => {
    // 两份表并存且自称同一个集合。加一档却忘了这里 ⇒ 同一个档位走 env 进得来、
    // 走 `set_mode` 进不来（客户端按了没反应），或反之。要改就得**同时**决定
    // daemon 拿新档怎么办（`auto` 那条注释就是一次这样的决定）。
    expect([...DAEMON_PERMISSION_MODES].sort()).toEqual([...ALL_MODES].sort())
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
