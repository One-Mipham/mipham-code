import type { PermissionConfig, PermissionMode } from '../shared/index.ts'

const DEFAULT_CONFIG: PermissionConfig = {
  mode: 'default',
  allow: [],
  deny: [],
}

/**
 * Load permission configuration from a settings object.
 * Merges with defaults for missing fields.
 */
export function loadPermissionConfig(raw: Partial<PermissionConfig> = {}): PermissionConfig {
  return {
    mode: (raw.mode as PermissionMode) || DEFAULT_CONFIG.mode,
    allow: Array.isArray(raw.allow) ? raw.allow : [...DEFAULT_CONFIG.allow],
    deny: Array.isArray(raw.deny) ? raw.deny : [...DEFAULT_CONFIG.deny],
  }
}

/** Valid mode transition order for Shift+Tab cycling. */
export const MODE_CYCLE: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
]

export function nextMode(current: PermissionMode): PermissionMode {
  const idx = MODE_CYCLE.indexOf(current)
  return MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]!
}
