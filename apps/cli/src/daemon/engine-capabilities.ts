/**
 * daemon 侧的引擎能力接线 —— 「两条渲染路径只接一条」的收口（ROADMAP T5）。
 *
 * 交互式 CLI 的装配内联在 `index.tsx`（约 300 行，含 TUI 专属件），而 daemon 这条
 * 路径此前**一个 setter 都没接**。后果分三档，且都不报错：
 *
 * - `setSkills` 缺 ⇒ `createToolRegistry()` 无参调用照样把 `Skill` 工具挂进了注册表，
 *   但工具上下文里没有 loader ⇒ 那个工具**每次调用都返回错误**（模型被广告了一个
 *   永远失败的工具）。
 * - `setRulesLoader` / `setHookEngine` / `setAgentRegistry` 缺 ⇒ 静默退化：
 *   `injectRules()` 永远早退、hooks 全不跑、自定义 agent 解析不到（`agent.ts` 里是
 *   `?.` 可选链，连警告都没有）。
 * - `setLlm` 是**反例**：daemon 原本没有缝，`llmChat` 回退 registry、provider 回退
 *   照常工作。所以顺序不可颠倒 —— 先修 `chatWithFallback` 的判据（见该处注释），
 *   再接，否则「对等」会削掉 daemon 唯一还活着的回退。
 *
 * 这类缺口 lint / typecheck / 覆盖率 / 安全审计**全部看不见**（上一次同类事故是
 * `rules-loader`，定义后潜伏数月，靠覆盖率实测才挖出来）。所以这里不只接线，还把
 * daemon 该有的能力集中到**一个**装配点，让「再加一个能力忘了接 daemon」变成
 * `test/integrity/daemon-capability-parity.test.ts` 能咬住的源码差异，而不是靠人记得。
 *
 * 不搬 `index.tsx` 的整套装配：ArtifactServer 是 TUI 画廊的 localhost 监听器、
 * AgentViewManager 的唯一消费者是 TUI slash 命令。这里接**有后果的六条**
 * （skills / rulesLoader / hookEngine / agentRegistry / instructions + 系统提示 / llm）；
 * 其余按后果分级进守卫的具名豁免表，逐条写理由。
 */

import type { QueryEngine } from '../core/engine'
import type { ProviderRegistry } from '../providers/registry'
import { SkillsLoader } from '../skills/loader'
import { RulesLoader } from '../core/rules-loader'
import { HookEngine } from '../core/hooks'
import { registerBuiltinHooks } from '../core/merge-gate'
import { loadHookConfigs } from '../core/hooks-config'
import { isSafeMode } from '../core/safe-mode'
import { loadSettingsJson } from '../config/loader'
import { getWorkspaceTrust, warnProjectHooksSkipped } from '../core/workspace-trust'
import { AgentRegistry } from '../agent/agent-registry'
import { InstructionsLoader } from '../core/instructions'
import { loadSessionMemories } from '../core/memory/memory-loader'
import { SessionLog } from '../core/session-log'
import { miphamHome } from '../core/paths'

export interface DaemonEngineCapabilities {
  /** 会话工作目录 —— 三者的派生源（外部 skill 路径 / hooks / agents 都从它算）。 */
  cwd: string
  /** daemon 共享的 provider registry，注入为 LLM 缝。 */
  registry: ProviderRegistry
  /** `config.skills.paths`（外部 skill 目录）。省略即只加载内置与用户 skill。 */
  skillsPaths?: string[]
  /** `config.skills.reminder`。省略即 `full`，与 CLI 侧的默认同。 */
  skillsReminder?: 'full' | 'compact' | 'off'
}

/**
 * 按 cwd 记忆化。
 *
 * daemon 是一个长命进程服务多个会话、cwd 各不相同，而 skills / hooks / agents 三者
 * 都从 cwd 派生（`config.skills.paths` / `<cwd>/.mipham/settings.json` /
 * `<cwd>/.mipham/agents`）。每次 `getOrCreateEngine` 都重建会重复读盘与解析。
 *
 * 缓存是**有界**的：cwd 必须先过 `isCwdAllowed`（在 daemon 根之内，或在用户信任
 * 列表里 —— 见 `workspace-guard.ts`），不是调用方随便给的路径。
 *
 * 代价已认下：表活到进程结束，所以改 `~/.mipham/settings.json` 或项目 agents 要
 * **重启 daemon** 才生效。CLI 是一次性进程，没这个问题 —— 不做 per-session rebuild，
 * 真要失效化另立条目。
 */
const skillsCache = new Map<string, SkillsLoader>()
const hookCache = new Map<string, HookEngine>()
const agentCache = new Map<string, AgentRegistry>()

function skillsFor(cwd: string, paths?: string[]): SkillsLoader {
  const cached = skillsCache.get(cwd)
  if (cached) return cached
  const loader = new SkillsLoader()
  // 内置 skill 从包内解析（`import.meta.dirname`），与 cwd 无关；用户 skill 在
  // `~/.mipham/skills`。三者里只有外部路径随 cwd 变。
  loader.loadBuiltinFromPackage()
  if (!isSafeMode()) {
    loader.loadUserSkills()
    if (paths && paths.length > 0) loader.loadExternal(paths)
  }
  skillsCache.set(cwd, loader)
  return loader
}

/**
 * skill 自带的 hooks 先注册，`settings.json` 的随后 —— 与 `index.tsx:585-598` 同序。
 *
 * 内置 skill 当前**一个都不声明 hooks**（实测 grep 为 0），所以这条只在用户自装
 * skill 上生效。留着是为了两入口的行为集合真的相等：少了它，装了带 hooks 的 skill
 * 的用户在 daemon 里会静默少跑一半 hooks —— 正是本项要消灭的那类缺口。
 *
 * 注意 `settings.json` 是**仓库可控**的文件（`<cwd>/.mipham/settings.json`），
 * 其 hooks 会 spawn shell。这与 CLI 同构，但 daemon 的会话可被远程渠道调用者驱动，
 * 属本次已认下的后果，见 ROADMAP T5 落地结果。
 */
function hooksFor(cwd: string, skills: SkillsLoader): HookEngine {
  const cached = hookCache.get(cwd)
  if (cached) return cached
  // 会话 cwd 必须显式传：daemon 一个进程服务多个会话，`process.cwd()` 是它自己被
  // 启动时所在的目录，不属于任何会话 —— hooks 会在那里跑，并且**被告知**它在那里。
  const engine = new HookEngine(cwd)
  if (isSafeMode()) {
    hookCache.set(cwd, engine)
    return engine
  }
  for (const skill of skills.list()) {
    for (const hook of skill.hooks ?? []) engine.register(hook)
  }
  registerBuiltinHooks(engine)
  // 项目级 hooks 是仓库可控的代码执行面，且 daemon 这条路径**从不**经过交互式信任
  // 询问 —— 而 `isCwdAllowed` 只要求会话 cwd 在 daemon 根目录之内（`workspace-guard.ts:27`
  // `isWithin(cwd, daemonRoot) || isTrusted(cwd)`）⇒ 在未信任的克隆里启动的 daemon，
  // 以前会照着那个仓库的 settings.json 起子进程。未信任即不加载，并说出口。
  const projectHooksTrusted = getWorkspaceTrust().isTrusted(cwd)
  const settings = loadSettingsJson(cwd, { includeProjectHooks: projectHooksTrusted })
  if (settings.projectHooksSkipped) warnProjectHooksSkipped(cwd)
  // Same setting, same meaning on the daemon path — a session started by the
  // daemon must not run hooks the CLI would have skipped.
  if (!settings.disableAllHooks) {
    for (const def of loadHookConfigs(settings.hooks)) engine.register(def)
  }
  hookCache.set(cwd, engine)
  return engine
}

function agentsFor(cwd: string): AgentRegistry {
  const cached = agentCache.get(cwd)
  if (cached) return cached
  const registry = new AgentRegistry()
  if (!isSafeMode()) {
    registry.loadUserAgents()
    registry.loadProjectAgents(cwd)
  }
  agentCache.set(cwd, registry)
  return registry
}

/**
 * 指令装载器，**每会话新建、不记忆化** —— 与 `RulesLoader` 同一个理由（见 D7）：
 * 一个长命 daemon 服务多个会话，按 cwd 共享一只的话，会话期间改过的 `CLAUDE.md` /
 * `MIPHAM.md` 对所有后来新建的会话都**永远看不见**，直到那个 loader 自己 `refresh()`。
 * 代价只是每次建引擎多读几个小文件 —— 与「配额规则」那点成本同量级。
 *
 * 它是**系统提示里「项目规则」那一段**的唯一来源（`MIPHAM.md` / `CLAUDE.md` / `AGENTS.md`
 * / `USER.md` 链 + CRSI 教训），也是 CRSI 召回扳机的指针来源 —— 两者必须是同一份选择，
 * 否则「扳机说去读那份文件」与「提示里写的是另一份」会分叉。
 */
function loadInstructionsFor(cwd: string): InstructionsLoader {
  const loader = new InstructionsLoader()
  loader.loadAll(cwd)
  return loader
}

/**
 * 把一个 daemon 引擎接成「和交互式 CLI 同等能干活」的样子。
 *
 * 调用点在 `server.ts` 的 `getOrCreateEngine`，紧跟 `setSessionId` —— 引擎建成之后、
 * 进 `engineCache` 之前，保证任何取到引擎的路径都已经接过线。
 */
export function wireDaemonEngine(engine: QueryEngine, opts: DaemonEngineCapabilities): void {
  const skills = skillsFor(opts.cwd, opts.skillsPaths)
  engine.setSkills(skills)

  // **每会话新建、不记忆化**：`setRulesLoader` 会顺手 `loader.load()`
  // （`engine.ts:352-355`），而 `load()` 是同步、幂等、先清空再读几个小文件
  // （`rules-loader.ts:42-61`）。共享一只的话，一个长命 daemon 会永远看不见会话
  // 期间新增的规则；不共享的代价只是每次建引擎多读一次目录。
  engine.setRulesLoader(new RulesLoader(opts.cwd))

  engine.setHookEngine(hooksFor(opts.cwd, skills))
  engine.setAgentRegistry(agentsFor(opts.cwd))

  // ── 系统提示：daemon 此前**一条都没有** ──────────────────────────────
  // 后果不是「提示朴素一点」，而是整条 headless 路径上模型不知道自己是谁：
  // MIPHAM.md 的身份段（集团 MIPHAM.md §〇，强制性）、CLAUDE.md 的项目规则、
  // 记忆、skills 提醒**一条都到不了**经渠道（飞书 / Telegram / 企微 / 钉钉）、
  // `attach` 远端、以及基准 harness 驱动的会话。
  //
  // 与 CLI 同源、同顺序（`index.tsx:524` + `:605-771`），只少三样**会话脚手架**：
  // 首跑引导 / 密钥到期提醒 / 上一会话摘要 —— 它们属于「一次性的终端会话」，
  // 而 daemon 一个进程服务多个会话，把它们烘进每个会话的提示只是噪音。
  const instructions = loadInstructionsFor(opts.cwd)
  engine.setInstructions(instructions)

  const context = engine.getContext()
  // 权限段**读时派生**。烘进去的会是模式的一份拷贝，而 daemon 的档位会经 `set_mode`
  // 在会话中途变（`server.ts` 的 `sessionModes`）：往窄切是自纠正的，**往宽切**则让
  // 模型拿着旧指令拒绝做它已被允许做的事。接的是 live 的 `permission`，同一实例也交给
  // 引擎去执行，故下一次请求就与新档一致。
  context.setPermissionContextSource(() =>
    instructions.buildPermissionBlock(engine.getPermission().getMode()),
  )

  const basePrompt = instructions.buildSystemPrompt()
  const extras = [
    skills.buildSystemReminder(5000, opts.skillsReminder ?? 'full'),
    // 预算显式给 5000：`getMemoryManager()` 是进程级单例，跟着某个会话的窗口走会让
    // 后建的会话改掉前一个的预算 —— daemon 的会话窗口各不相同，这是唯一不互相干扰的取值。
    loadSessionMemories(basePrompt, 5000),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')

  // `buildSystemPrompt()` 结尾**没有换行**，`extras` 以 `<system-reminder>` 开头：
  // 直接相加会把标签粘在上一句末尾（CLI 侧 `index.tsx` 是 `\n\n` 连接）。建提示与
  // 压缩后的重建必须走同一个连接方式，否则两条路径的提示形状会分叉。
  const withExtras = (base: string): string => (extras ? `${base}\n\n${extras}` : base)
  context.setSystemPrompt(withExtras(basePrompt))
  // 压缩之后引擎会让提示重建一次；重建前先回读磁盘，**只换指令那一段**，`extras`
  // 原样保留 —— 那是建会话时拼进来的会话级上下文，再生成一遍等于把它们重复塞进每个请求。
  context.setSystemPromptRebuilder(() => {
    instructions.refresh()
    return withExtras(instructions.buildSystemPrompt())
  })

  // 语义等价于不接（`llmChat` 本就是 `this.llm ?? this.registry`），接上是为了让
  // 两个入口的能力集合真的相等；D2 靠它证明「先修语义再对等」这条顺序约束。
  engine.setLlm(opts.registry)
}

/**
 * daemon 会话日志目录 —— **与 CLI 的 `~/.mipham/sessions` 分开**是设计的一部分。
 *
 * daemon 的历史真源是它自己的 SQLite（`daemon.db`，REST API 也读它），日志只记**本进程
 * 窗口内**发生的事。若落进 `sessions/`，`SessionStore.list()` 会把它当成一个可恢复会话
 * 列出来，而它的历史是不全的 —— 那就造出一个「看起来能恢复、恢复出来缺半截」的假广告，
 * 正是本仓反复在修的那一类。分目录之后，`--resume` **结构上**够不到它。
 */
export function daemonSessionLogDir(): string {
  return miphamHome('daemon-sessions')
}

export interface DaemonSessionLogFacts {
  sessionId: string
  cwd: string
  provider: string
  model: string
  permissionMode: string
}

/**
 * 给 daemon 会话挂一份**审计用**日志 —— 收口「daemon 会话一条 JSONL 都不写」（ROADMAP T5）。
 *
 * 三条约束，每条都有后果：
 *
 * 1. **必须在 DB 回灌之后调用**（`server.ts` 里紧跟 `wireDaemonEngine`）。日志记的是
 *    「本进程期间发生了什么」。把回灌的历史镜像进来会**重复追加**同一批消息 ——
 *    `WorkerPool` 会驱逐空闲 worker，重建引擎时那段历史会被再写一遍 ——
 *    而且把一个审计增量伪装成完整历史。
 * 2. **`authoritative: false`**：`ContextManager` 的「model-visible means logged」断言
 *    只对**完整**日志有意义。残缺日志会让它对每一行旧历史报警，开着的调试断言会因此
 *    炸掉整个 daemon 会话。关掉的是**断言**，写通照常。
 * 3. 名字取 `daemon-<uuid>`：让人一眼看出它不是 CLI 的会话名。
 *
 * **已知边界（如实记）**：日志里 `compaction/summary` 的 `replacedCount` 是按**日志窗口**
 * 算的（`context.ts` 用 `deriveMessages(log)` 的长度），不是按整段对话 —— 旧历史从没进过
 * 这份日志。读审计文件时要知道这个数只对「被记录的那一段」成立。
 */
export function attachDaemonSessionLog(
  engine: QueryEngine,
  facts: DaemonSessionLogFacts,
): SessionLog {
  const log = new SessionLog(`daemon-${facts.sessionId}`, daemonSessionLogDir())
  log.append({
    type: 'session/start',
    at: Date.now(),
    sessionId: facts.sessionId,
    provider: facts.provider,
    model: facts.model,
    cwd: facts.cwd,
    permissionMode: facts.permissionMode,
  })
  engine.getContext().setLog(log, { authoritative: false })
  return log
}
