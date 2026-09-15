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
 * AgentViewManager 的唯一消费者是 TUI slash 命令。这里只接**有后果的四条**加
 * `setLlm`；其余按后果分级进守卫的具名豁免表，逐条写理由。
 */

import type { QueryEngine } from '../core/engine'
import type { ProviderRegistry } from '../providers/registry'
import { SkillsLoader } from '../skills/loader'
import { RulesLoader } from '../core/rules-loader'
import { HookEngine } from '../core/hooks'
import { loadHookConfigs } from '../core/hooks-config'
import { loadSettingsJson } from '../config/loader'
import { AgentRegistry } from '../agent/agent-registry'

export interface DaemonEngineCapabilities {
  /** 会话工作目录 —— 三者的派生源（外部 skill 路径 / hooks / agents 都从它算）。 */
  cwd: string
  /** daemon 共享的 provider registry，注入为 LLM 缝。 */
  registry: ProviderRegistry
  /** `config.skills.paths`（外部 skill 目录）。省略即只加载内置与用户 skill。 */
  skillsPaths?: string[]
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
  loader.loadUserSkills()
  if (paths && paths.length > 0) loader.loadExternal(paths)
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
  const engine = new HookEngine()
  for (const skill of skills.list()) {
    for (const hook of skill.hooks ?? []) engine.register(hook)
  }
  for (const def of loadHookConfigs(loadSettingsJson(cwd).hooks)) engine.register(def)
  hookCache.set(cwd, engine)
  return engine
}

function agentsFor(cwd: string): AgentRegistry {
  const cached = agentCache.get(cwd)
  if (cached) return cached
  const registry = new AgentRegistry()
  registry.loadUserAgents()
  registry.loadProjectAgents(cwd)
  agentCache.set(cwd, registry)
  return registry
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

  // 语义等价于不接（`llmChat` 本就是 `this.llm ?? this.registry`），接上是为了让
  // 两个入口的能力集合真的相等；D2 靠它证明「先修语义再对等」这条顺序约束。
  engine.setLlm(opts.registry)
}
