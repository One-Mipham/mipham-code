import type { HookConfig, HookEvent, HookDefinition, HookContext } from '../shared/index.ts'
import { executeHook } from './hooks-executor'

export interface HookConfigEntry {
  matcher: string
  hooks: HookConfig[]
}

/** `settings.json` `hooks` section — one matcher-group list per event. */
export interface SettingsHooks {
  PreToolUse?: HookConfigEntry[]
  PostToolUse?: HookConfigEntry[]
  PostToolUseFailure?: HookConfigEntry[]
  SessionStart?: HookConfigEntry[]
  SessionEnd?: HookConfigEntry[]
  Notification?: HookConfigEntry[]
  Stop?: HookConfigEntry[]
  UserPromptSubmit?: HookConfigEntry[]
  PreCompact?: HookConfigEntry[]
  PostCompact?: HookConfigEntry[]
  /** ⚠️ 目前**没有派发点** —— 写在这里不报错，但不会跑。见 `UNDISPATCHED_EVENTS`。 */
  ConfigChange?: HookConfigEntry[]
  SubagentStart?: HookConfigEntry[]
  SubagentStop?: HookConfigEntry[]
  /** ⚠️ 目前**没有派发点** —— 写在这里不报错，但不会跑。见 `UNDISPATCHED_EVENTS`。 */
  PreInference?: HookConfigEntry[]
}

/**
 * `settings.json` 接受、但**生产代码里没有任何派发点**的事件。
 *
 * `HookEngine` 上这两个事件各有一个现成方法（`hooks.ts:162` / `:222`，名字见 ROADMAP D18），
 * 而它们在 `src/` + `bin/` 里**零引用** —— `grep` 只剩定义行与测试。注册进去的后果不是
 * 「静默不生效」那么简单：`/hooks` 遍历的是**配置文件本身**（`ui/commands.ts`），于是用户
 * 看到自己那条 hook 被列出来、计入 `hooks.found N` —— 读起来是「已安装」，实际一次都不会跑。
 * **被告知的东西与发生的事分叉，比「不支持」更坏。**
 *
 * 所以这里**不注册**并说出原因。`/hooks` 读的是配置文件本身、不读注册表，故单靠这一层
 * 并不能改变它的输出 —— 它会**继续列出**这些条目，所以 `ui/commands.ts` 的 `/hooks`
 * 必须用同一个集合给它们打「不会运行」标记并排除出计数。两处共用一个集合，名单才不会
 * 各写一份、各自漂移。接线本身是独立决定（ROADMAP D18）：`PreInference` 要先定
 * 「settings.json 的任意命令 hook」与「把整段对话正文发往组织端点的 DLP」如何共存 ——
 * 后者是数据出境面，不能顺手接。
 *
 * ⚠️ 本注释**刻意不逐字写出那两个方法名**：`unwired-disposition.test.ts` 的
 * `referencesOutside` 匹配的是**文本出现**、不是调用点，写出来就会把那条守卫打红
 * （它自己的 docblock 里写着这条反向边界）。要查名字去看 ROADMAP D18。
 */
export const UNDISPATCHED_EVENTS = new Set<string>(['ConfigChange', 'PreInference'])

/**
 * Load hook configurations from a settings object and convert them to
 * executable HookDefinitions suitable for the HookEngine.
 */
export function loadHookConfigs(configs: SettingsHooks): HookDefinition[] {
  const definitions: HookDefinition[] = []

  for (const [eventName, entries] of Object.entries(configs)) {
    if (!entries || !Array.isArray(entries)) continue

    if (UNDISPATCHED_EVENTS.has(eventName)) {
      process.stderr.write(
        `⚠️  Hook event ${eventName} has no dispatch point in this version — ` +
          `${entries.length} configured hook group(s) under it will not run and are not registered.\n`,
      )
      continue
    }

    for (const entry of entries) {
      // A group with no `hooks` array used to throw at `for … of entry.hooks`
      // and take *every* hook with it — one malformed group disabled the entire
      // wiring (CC 2.1.122-017). Skip that group, keep the rest.
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
        process.stderr.write(
          `⚠️  Hook group on ${eventName} has no "hooks" array — skipped; other hooks still load.\n`,
        )
        continue
      }
      // A matcher is only a *filter*, so a malformed one must not take the whole
      // hook set down with it. `new RegExp` throws here, and both callers register
      // the result in a plain `for…of` (`index.tsx:742`,
      // `daemon/engine-capabilities.ts:104`) — so one typo aborts startup, or the
      // session's entire hook wiring, before a single hook is registered. The
      // remaining entries are independent and still work; only this one is
      // degraded, and it is degraded in the direction `HookEngine.matchesMatcher`
      // already documents: matcher absent ⇒ run on every invocation — the
      // fail-closed choice for a guard.
      let matcherRegex: RegExp | null = null
      if (entry.matcher) {
        try {
          matcherRegex = new RegExp(entry.matcher)
        } catch {
          process.stderr.write(
            `⚠️  Hook matcher ${JSON.stringify(entry.matcher)} on ${eventName} is not a valid regex — ` +
              `running that hook on every invocation.\n`,
          )
        }
      }

      for (const hookCfg of entry.hooks) {
        definitions.push({
          event: eventName as HookEvent,
          toolName: entry.matcher || undefined,
          // The engine's own failure paths (a handler that throws, a hook
          // auto-disabled for repeated failures) see the definition, not the
          // config, and an opted-open guard must stay open there too.
          failureMode: hookCfg.failureMode,
          handler: async (ctx: HookContext) => {
            // Check matcher if tool-specific
            if (matcherRegex && ctx.toolName && !matcherRegex.test(ctx.toolName)) {
              return { allowed: true }
            }
            return executeHook(hookCfg, ctx)
          },
        })
      }
    }
  }

  return definitions
}
