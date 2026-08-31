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
      const matcherRegex = entry.matcher ? new RegExp(entry.matcher) : null

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
