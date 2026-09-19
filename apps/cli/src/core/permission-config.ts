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
 * Nominal permissiveness ranking, least → most permissive. Two consumers only:
 * `maxAllowedMode` (drop every mode ranked above the cap) and `clampMode` (walk
 * downward to the nearest allowed mode below the one requested).
 *
 * **The four modes are not totally ordered in reality**, so this array carries
 * only the relations that are actually measurable:
 *
 * - `plan` is strictly the narrowest. It passes only Read/Grep/Glob and sends
 *   *everything* else to approval, while `default` passes every tool that
 *   declares `permission: 'auto'` — git, task, web-fetch, cron, memory, … So a
 *   cap of `'plan'` must not admit `default`, and `plan` belongs at the bottom.
 * - `acceptEdits` and `default` are **incomparable**: acceptEdits auto-approves
 *   Write/Edit and verification-only Bash that `default` asks about, while
 *   `default` auto-approves the non-file `'auto'` tools that acceptEdits asks
 *   about. No total order is faithful there, so the ranking only needs to carry
 *   the relations the two consumers rely on.
 *
 * The array used to read `default → acceptEdits → plan → …`, which **inverted**
 * both `plan` relations rather than merely approximating them: `maxAllowedMode:
 * 'plan'` admitted acceptEdits *and* default — the ceiling let through the wider
 * mode each time. The pairs are pinned by a probe in `test/core/permission.test.ts`
 * (P4) so the claim stays measured rather than asserted.
 */
export const PERMISSION_MODE_HIERARCHY: PermissionMode[] = [
  'plan',
  'default',
  'acceptEdits',
  'bypassPermissions',
]

/**
 * Shift+Tab cycling order — deliberately **not** the permissiveness order above.
 * The cycle is UX (manual → accept edits → plan → bypass); only the hierarchy
 * answers "is this mode wider than that one". Keeping them separate is what lets
 * `forbiddenModes` drop an entry from the cycle without disturbing the ranking
 * that `clampMode` walks.
 */
export const MODE_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

/** Resolve which modes are actually permitted given the restrictions. */
function getAllowedModes(restrictions?: PermissionRestrictions): PermissionMode[] {
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
