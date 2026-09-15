/**
 * daemon 与交互式 CLI 的能力对等有守卫。
 *
 * 这是「两条渲染路径只接一条 = 局部正确全局遗漏」的**第二次**发生（T5）。第一次是
 * `core/rules-loader.ts`：`setRulesLoader` 定义齐全、全仓库零调用点，潜伏数月，
 * lint / typecheck / knip / 覆盖率 / 安全审计**全部看不见**（见同目录
 * `tool-reference-integrity.test.ts` 开头列的四次事故）。
 *
 * 根因不是谁粗心，是结构性的：装配散在 `index.tsx` 里，没有单一装配点，于是每加一个
 * 能力就要单独记得「再去 daemon 接一次」——历史上 telegram / wecom / dingtalk /
 * allow-deny / permissionRestrictions / contextWindow 每一个都是独立一次提交。
 *
 * 所以这里断的不是「某几个能力接没接」，是**两个入口的注入集合是否相等**：全集从
 * `engine.ts` 的源码结构里枚举（不抄清单），两个入口各自扫出实际注入的那些，差额
 * 必须**恰好等于**下面那张**有名字、有理由、有源码锚点**的豁免表。
 * 加一个能力忘了接 daemon ⇒ 红；接了却还挂在豁免表里（陈旧豁免）⇒ 也红。
 *
 * 本文件对 CLAUDE.md 体积、工具总数、技能清单、`stryker.config.json` 一律不置一词 ——
 * 那些各有专门守卫，重复断言只会让一处改动要改多个地方。
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 本文件只读 `apps/cli/` 之内的东西，故锚定包目录即可，不需要找仓库根。
 *
 * `../..` 在 Stryker 沙箱里同样成立：沙箱复制的是**整个包**到
 * `apps/cli/.stryker-tmp/sandbox-N/`，`test/integrity/` 的 `../..` 就是那份副本，
 * 不含仓库根（同目录 `mutation-wiring.test.ts` 也是这么取的）。
 */
const CLI_DIR = join(import.meta.dirname, '..', '..')
const ENGINE_SRC = join(CLI_DIR, 'src', 'core', 'engine.ts')
const SERVER_SRC = join(CLI_DIR, 'src', 'daemon', 'server.ts')
const CAPABILITIES_SRC = join(CLI_DIR, 'src', 'daemon', 'engine-capabilities.ts')

/**
 * 剥掉注释与字符串字面量，保留换行。
 *
 * 剥的理由很具体：`index.tsx:613-614` 有一句散文注释
 * 「Loaded once at startup; setRulesLoader performs the load.」—— 它是本仓库
 * 最容易被误认成调用点的一行，而它恰恰**不是**调用（真正的调用在第 615 行）。
 * 不剥字符串则更糟：任何错误消息里提到 `engine.setSkills(` 都会让守卫变绿。
 *
 * 已知边界：不认得正则字面量。engine.ts / 本守卫扫描面里若有形如 `/\/\//` 的
 * 正则，扫描会从那里起偏（实测当前没有）。加正则字面量后请顺手核一遍枚举数。
 */
function stripNonCode(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      out += ' '
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          out += '  '
          i += 2
          continue
        }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += ' '
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * `engine.ts` 上的全部注入点 —— **从源码结构枚举，不抄清单**。
 *
 * 两个空格缩进即类成员：这既拿到全部 14 个 setter，又顺带把
 * `PermissionSystem.setDefaultLevel` 之类别的类的同名方法挡在外面。
 * 抄一份清单的话，新加的 `setXxx` 会永远逃过这条守卫，而守卫本身看起来毫无问题 ——
 * 那正是本仓库反复吃过的「有定义、无施加点」。
 */
const ENGINE_SETTERS: string[] = [
  ...stripNonCode(readFileSync(ENGINE_SRC, 'utf-8')).matchAll(/^ {2}(set[A-Z]\w*)\(/gm),
]
  .map((m) => m[1]!)
  .sort()

const ENGINE_SETTER_SET = new Set(ENGINE_SETTERS)

/**
 * 找出源码里对**引擎注入点**的调用，要求**带接收者**（`X.setY(`）。
 *
 * 带接收者是必需的：`engine.ts` 自己那 14 行是**定义**，不带接收者会把定义当成
 * 「已接线」——守卫就永远绿了。
 *
 * 已知残洞（照实写在这里，不粉饰）：只认 `X.setY(` 这一种形态。
 * ① 动态装配（`applySetters(engine, CAPS)`、`Object.assign`）看不见 —— 真出现这种
 * 机制请同时扩展本函数，别指望它自己发现；`daemon-capability-parity` 的整套思路就是
 * 「接线路径必须是可被静态枚举的」。
 * ② 接收者不校验类型，`ui/commands.ts` 里的 `ctx.setGoal(` 会被算作已接线。扫描面
 * 已收窄到两个入口目录，误认概率低，但它是误认而非证明。
 */
function findSetterCalls(src: string): string[] {
  const found = new Set<string>()
  for (const m of stripNonCode(src).matchAll(/\b[A-Za-z_$][\w$]*\??\.(set[A-Z]\w*)\(/g)) {
    if (ENGINE_SETTER_SET.has(m[1]!)) found.add(m[1]!)
  }
  return [...found].sort()
}

function walkFiles(roots: string[]): string[] {
  const found: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    if (statSync(root).isFile()) {
      found.push(root)
      continue
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const p = join(root, entry.name)
      if (entry.isDirectory()) found.push(...walkFiles([p]))
      else if (/\.tsx?$/.test(entry.name)) found.push(p)
    }
  }
  return found.sort()
}

/**
 * 两个入口的装配面。
 *
 * CLI 侧含 `ui/`：`setEffort` / `setGoal` / `setOnWakeupEnqueued` 是在 TUI 命令层
 * 接的，不在 `index.tsx` 的引导路径上。不收进来的话，这三个会被误判成「CLI 也没接」，
 * 而它们其实是接了的 —— 守卫的误报必须为零，否则会被习惯性绕过。
 */
interface WiringTarget {
  id: string
  label: string
  roots: string[]
  /** 装配面里**不算数**的文件（basename），理由见下。 */
  excludes: string[]
}

const TARGETS: WiringTarget[] = [
  {
    id: 'cli',
    label: '交互式 CLI（index.tsx + TUI 命令层）',
    roots: [join(CLI_DIR, 'src', 'index.tsx'), join(CLI_DIR, 'src', 'ui')],
    excludes: [],
  },
  {
    id: 'daemon',
    label: 'daemon',
    roots: [join(CLI_DIR, 'src', 'daemon')],
    // `remote-engine.ts` 是 `mipham attach` 的**客户端桩**：TUI 连远程 daemon 时
    // 冒充 QueryEngine，`setGoal` / `setEffort` / `setAgentRegistry` 全是空实现
    // （`getAgentViewManager()` 直接 `return undefined`）。它算进来的话，守卫会在
    // 「客户端假装支持」时变绿 —— 而 daemon 侧其实什么都没接。
    excludes: ['remote-engine.ts'],
  },
]

interface Exemption {
  /** 为什么这个入口**有意**不接这个注入点。少于 30 字符会被断言拒绝。 */
  reason: string
  /** 理由赖以成立的源码事实：文件 + 必须仍在其中的字面量。 */
  anchor: { file: string; contains: string }
}

/**
 * 具名豁免表 —— 两个入口 × 有意不接的注入点。
 *
 * 每一条都必须能指着一段**仍然存在**的源码说话（`anchor`）。理由是会腐烂的东西：
 * 半年后有人重写了 ArtifactServer，`setArtifactServer` 就不再是「TUI 专属」了，
 * 而一张只写散文的表不会自己告诉你这件事。
 */
const EXEMPT: Record<string, Exemption> = {
  'daemon:setArtifactServer': {
    reason:
      'ArtifactServer 是 TUI 画廊的 localhost 监听器，daemon 侧不接则 Artifact 工具退化为 file:// 输出；接上等于在一个 headless 进程里再开一个监听面，无收益',
    anchor: { file: 'src/tools/artifact/artifact.ts', contains: '`file://${filepath}`' },
  },
  'daemon:setAgentViewManager': {
    reason:
      '唯一消费者是 TUI 的 slash 命令；daemon 自己的客户端桩 getAgentViewManager() 直接返回 undefined，接上也无人读',
    anchor: { file: 'src/daemon/remote-engine.ts', contains: 'getAgentViewManager(): undefined' },
  },
  'daemon:setInferenceHookConfig': {
    reason:
      '待决策的数据出境面（deferred，非 designed-out）：PreInference DLP 会把整段对话正文发往组织端点，而 daemon 会话可被 feishu/telegram/wecom/dingtalk 的第三方调用者开启。要接应先定「daemon 会话是否允许出站」',
    anchor: { file: 'src/index.tsx', contains: 'loadInferenceHookConfig()' },
  },
  'daemon:setCrossSessionConfig': {
    reason:
      '接上用户那份更宽松的入站策略会在一个没有审批 UI 的入口扩大跨会话接受面：引擎默认 crossSessionInbound 是 ask 且 fail-closed，daemon 现在跑的正是这个默认值',
    anchor: { file: 'src/core/engine.ts', contains: "crossSessionInbound: 'ask'" },
  },
  'daemon:setCrsiConfig': {
    reason:
      '全仓库零调用点（CLI 侧同样没接），不是 daemon 特有缺口；属既有欠账，已另记 ROADMAP，不靠本守卫假装已决',
    anchor: { file: 'src/core/engine.ts', contains: 'private crsiConfig?: Partial<CrsiConfig>' },
  },
  'daemon:setEffort': {
    reason:
      'effort 是会话级 UI 选择（Ctrl+P 同层的模型选择器），由 TUI 设置；daemon 的会话元数据里没有这一维，接上只能给个常量，等于假的「对等」',
    anchor: { file: 'src/ui/app.tsx', contains: 'engine.setEffort(' },
  },
  'daemon:setGoal': {
    reason:
      'daemon 走自己的 goal-manager.ts（createGoal/getGoals 按 sessionId 落库），不经 engine.setGoal 的内存态分解；两套并存是 daemon 持久化设计的一部分',
    anchor: { file: 'src/daemon/server.ts', contains: 'goalManager.createGoal(' },
  },
  'daemon:setOnWakeupEnqueued': {
    reason:
      '唤醒入队回调是 TUI 用来刷新界面的（qe.setOnWakeupEnqueued），daemon 没有常驻界面要刷；调度本身走 schedule-manager，不依赖这个回调',
    anchor: { file: 'src/ui/app.tsx', contains: '.setOnWakeupEnqueued(' },
  },
  'cli:setCrsiConfig': {
    reason:
      '与 daemon 侧同一件事：全仓库零调用点。缺的不是「daemon 没接」，是「谁都没接」，两条入口各记一条以免其中一条被误当成已决',
    anchor: {
      file: 'src/core/engine.ts',
      contains: 'setCrsiConfig(config: Partial<CrsiConfig> | undefined)',
    },
  },
}

/** 收集某个入口实际注入的全部注入点。 */
function wiredOf(target: WiringTarget): string[] {
  const found = new Set<string>()
  for (const file of walkFiles(target.roots)) {
    if (target.excludes.includes(file.split('/').pop()!)) continue
    for (const name of findSetterCalls(readFileSync(file, 'utf-8'))) found.add(name)
  }
  return [...found].sort()
}

describe('daemon 与 CLI 的能力对等', () => {
  it('能枚举到注入点与两个装配面（空转守卫）', () => {
    // 枚举为空的话，下面每条集合断言都会零次通过 —— 先钉住这一点。
    expect(existsSync(ENGINE_SRC)).toBe(true)
    expect(ENGINE_SETTERS.length).toBeGreaterThan(0)
    expect(ENGINE_SETTERS).toEqual(
      expect.arrayContaining([
        'setSkills',
        'setRulesLoader',
        'setHookEngine',
        'setAgentRegistry',
        'setLlm',
      ]),
    )
    for (const t of TARGETS) {
      expect(wiredOf(t).length, `${t.id} 装配面扫不出任何注入点`).toBeGreaterThan(0)
    }
    // 接线入口本身必须在
    expect(existsSync(CAPABILITIES_SRC)).toBe(true)
  })

  it('检测器：带接收者才算调用，注释与字符串里的同名一律看不见', () => {
    // 本仓库真实存在的一行散文注释（index.tsx 第 614 行）—— 它不是调用。
    expect(
      findSetterCalls('  // Loaded once at startup; setRulesLoader performs the load.'),
    ).toEqual([])
    expect(findSetterCalls('/* engine.setSkills(x) in a block comment */')).toEqual([])
    expect(findSetterCalls('const s = "engine.setLlm(y)"')).toEqual([])
    expect(findSetterCalls('const t = `engine.setLlm(z)`')).toEqual([])
    // 定义（无接收者）也不算 —— 否则 engine.ts 自己就把 14 个全「接线」了。
    expect(findSetterCalls('\n  setSkills(provider: Skills): void {\n')).toEqual([])
    // 带接收者、且**属于引擎注入点**的才算，别的类同名方法不算。
    expect(findSetterCalls('engine.setSkills(s)')).toEqual(['setSkills'])
    expect(findSetterCalls('some.panel.setActivePanel(p)')).toEqual([])
    expect(findSetterCalls('ctx.engine.setGoal(g)')).toEqual(['setGoal'])
  })

  it('两个入口各自缺的能力，恰好等于具名豁免表里的那些', () => {
    const exemptionKeys = Object.keys(EXEMPT).sort()
    const missingKeys: string[] = []
    for (const t of TARGETS) {
      const wired = new Set(wiredOf(t))
      for (const setter of ENGINE_SETTERS) {
        if (!wired.has(setter)) missingKeys.push(`${t.id}:${setter}`)
      }
    }
    // 两向相等。多一项 = 新能力没接（正是 T5 要抓的）；少一项 = 陈旧豁免
    // （已经接上了却还挂在表里 —— 那张表就不再描述现实）。
    expect(missingKeys.sort()).toEqual(exemptionKeys)
  })

  it('每条豁免都写了理由与仍存在的源码锚点', () => {
    for (const [key, ex] of Object.entries(EXEMPT)) {
      // 理由不是散文，是要能被人复核的判断。
      expect(ex.reason.length, `${key} 的理由过短`).toBeGreaterThan(30)
      const path = join(CLI_DIR, ex.anchor.file)
      expect(existsSync(path), `${key} 的锚点文件不存在：${ex.anchor.file}`).toBe(true)
      expect(
        readFileSync(path, 'utf-8').includes(ex.anchor.contains),
        `${key} 的锚点字面量已不在 ${ex.anchor.file} 里：${ex.anchor.contains}`,
      ).toBe(true)
    }
  })

  it('daemon 真的调用了接线入口，且在进缓存之前', () => {
    const server = readFileSync(SERVER_SRC, 'utf-8')
    // 只断言「engine-capabilities.ts 里那 5 个 setter 存在」是不够的：把
    // `wireDaemonEngine(` 的调用删掉，那些 setter 仍然躺在文件里，守卫照样绿 ——
    // 而「定义了没人调」正是本守卫要抓的那个形态。
    expect(server).toContain("from './engine-capabilities'")
    const call = stripNonCode(server).indexOf('wireDaemonEngine(')
    expect(call, 'server.ts 没有调用 wireDaemonEngine').toBeGreaterThan(-1)
    // 顺序不变量：接线必须发生在引擎进 engineCache 之前，否则存在拿到半接线引擎的路径。
    const cached = stripNonCode(server).indexOf('engineCache.set(')
    expect(cached).toBeGreaterThan(-1)
    expect(call).toBeLessThan(cached)
  })
})
