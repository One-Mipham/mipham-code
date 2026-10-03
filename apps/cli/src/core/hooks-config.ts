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
  ConfigChange?: HookConfigEntry[]
  SubagentStart?: HookConfigEntry[]
  SubagentStop?: HookConfigEntry[]
  PreInference?: HookConfigEntry[]
}

/**
 * Load hook configurations from a settings object and convert them to
 * executable HookDefinitions suitable for the HookEngine.
 */
export function loadHookConfigs(configs: SettingsHooks): HookDefinition[] {
  const definitions: HookDefinition[] = []

  for (const [eventName, entries] of Object.entries(configs)) {
    if (!entries || !Array.isArray(entries)) continue

    for (const entry of entries) {
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
