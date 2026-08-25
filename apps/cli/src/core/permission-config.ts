import type { PermissionConfig, PermissionMode, PermissionRestrictions } from '../shared/index.ts'

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
    restrictions: raw.restrictions ?? undefined,
  }
}

/**
 * Permission modes ordered from least to most permissive.
 * Used to enforce maxAllowedMode: any mode ranked higher than the cap is forbidden.
 */
export const PERMISSION_MODE_HIERARCHY: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]

/** Valid mode transition order for Shift+Tab cycling. */
export const MODE_CYCLE: PermissionMode[] = [...PERMISSION_MODE_HIERARCHY]

/** Resolve which modes are actually permitted given the restrictions. */
export function getAllowedModes(restrictions?: PermissionRestrictions): PermissionMode[] {
  let allowed = [...MODE_CYCLE]

  if (restrictions?.forbiddenModes && restrictions.forbiddenModes.length > 0) {
    const forbidden = new Set(restrictions.forbiddenModes)
    allowed = allowed.filter((m) => !forbidden.has(m))
  }

  if (restrictions?.maxAllowedMode) {
    const capIdx = PERMISSION_MODE_HIERARCHY.indexOf(restrictions.maxAllowedMode)
    if (capIdx >= 0) {
      allowed = allowed.filter((m) => PERMISSION_MODE_HIERARCHY.indexOf(m) <= capIdx)
    }
  }

  return allowed
}

/** Check whether a given mode is permitted under the restrictions. */
export function isModeAllowed(
  mode: PermissionMode,
  restrictions?: PermissionRestrictions,
): boolean {
  return getAllowedModes(restrictions).includes(mode)
}

/**
 * Return the highest allowed mode at or below `desired` given the restrictions.
 * Used to silently downgrade when a forbidden mode is requested.
 */
export function clampMode(
  desired: PermissionMode,
  restrictions?: PermissionRestrictions,
): PermissionMode {
  const allowed = getAllowedModes(restrictions)
  if (allowed.includes(desired)) return desired

  // Walk downward through the hierarchy to find the closest allowed mode
  const desiredIdx = PERMISSION_MODE_HIERARCHY.indexOf(desired)
  for (let i = desiredIdx - 1; i >= 0; i--) {
    const candidate = PERMISSION_MODE_HIERARCHY[i]!
    if (allowed.includes(candidate)) return candidate
  }

  // Fallback: return the first allowed mode (should always be at least 'default')
  return allowed[0] ?? 'default'
}

export function nextMode(
  current: PermissionMode,
  restrictions?: PermissionRestrictions,
): PermissionMode {
  const allowed = getAllowedModes(restrictions)
  const idx = allowed.indexOf(current)
  if (idx === -1) {
    // Current mode is not in the allowed set — clamp then find next
    return clampMode(current, restrictions)
  }
  return allowed[(idx + 1) % allowed.length]!
}
