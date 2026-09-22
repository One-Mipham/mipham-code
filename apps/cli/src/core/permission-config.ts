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
 *   declares `permission: 'self'` — git, task, web-fetch, cron, memory, … So a
 *   cap of `'plan'` must not admit `default`, and `plan` belongs at the bottom.
 * - `acceptEdits` and `default` are **incomparable**: acceptEdits auto-approves
 *   Write/Edit and verification-only Bash that `default` asks about, while
 *   `default` auto-approves the non-file `'self'` tools that acceptEdits asks
 *   about. No total order is faithful there, so the ranking only needs to carry
 *   the relations the two consumers rely on.
 *
 * The array used to read `default → acceptEdits → plan → …`, which **inverted**
 * both `plan` relations rather than merely approximating them: `maxAllowedMode:
 * 'plan'` admitted acceptEdits *and* default — the ceiling let through the wider
 * mode each time. The pairs are pinned by a probe in `test/core/permission.test.ts`
 * (P4) so the claim stays measured rather than asserted.
 *
 * `auto` sits between `acceptEdits` and `bypassPermissions` — the same rung Claude
 * Code puts it on. It has to sit above `acceptEdits`, because at runtime the
 * classifier may allow calls `acceptEdits` refuses (network, non-verification
 * Bash), so a ceiling of `acceptEdits` must not admit it. Its own static baseline
 * grants nothing at all, which is why the P4 width probe **excludes** it by name:
 * measuring "who is narrower" on the static chain would otherwise call `auto` the
 * narrowest mode of all and point the hierarchy's first slot at it.
 *
 * **Every member of `PermissionMode` must appear here.** A missing member makes
 * `indexOf` return `-1`, and `getAllowedModes` then skips the whole ceiling
 * (`if (capIdx >= 0)`) — the org-level cap goes silently inert, fail-open, with no
 * warning anywhere. There is a compile-time-exhaustive coverage assertion for this
 * in `test/core/permission.test.ts` (P4c); the ordering probe (P4) catches a wrong
 * *order* but never a *missing* entry.
 *
 * **Inserting `auto` moved a fallback destination, on purpose and without a
 * failure.** `clampMode` answers "the highest allowed mode at or below `desired`",
 * so every mode gains a neighbour below it. A config that forbids
 * `bypassPermissions` and then requests it now lands on `auto` — previously
 * `acceptEdits`. Both readings satisfy the contract and `auto` is a strict subset
 * of `bypassPermissions` at runtime (it gates each call), so the move narrows
 * rather than escalates; but it *is* a change in what those configs do, and it is
 * pinned in `test/core/permission.test.ts` and `test/daemon/permission.test.ts`
 * rather than left to be discovered. **Until the classifier is wired, `auto`'s
 * static baseline is `ask` throughout, so that landing means "every call
 * refused"** — fail-closed, and honest, but not a behaviour to install by accident.
 */
export const PERMISSION_MODE_HIERARCHY: PermissionMode[] = [
  'plan',
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
]

/**
 * Every **legal** mode — the full internal enumeration, and the base set that
 * `forbiddenModes` / `maxAllowedMode` are applied to.
 *
 * Deliberately a separate array from `MODE_CYCLE`, and deliberately able to be a
 * **superset** of it: `bypassPermissions` is reachable through config /
 * `MIPHAM_DAEMON_PERMISSION` / settings without being something a user can
 * Shift+Tab into. Claude Code arranges it the same way — its descriptor table
 * lists `bypassPermissions` while its cycle array does not.
 *
 * **The two arrays must not be collapsed back into one.** `getAllowedModes`
 * filters *this* array, never `MODE_CYCLE`. If it filtered the cycle, then the
 * moment the cycle stops listing `bypassPermissions`, a config requesting it
 * would be silently walked *down* to `acceptEdits` by `clampMode` — a quiet
 * downgrade of a security-relevant setting, with every existing test still
 * green. The fixed point is pinned by a probe in `test/core/permission.test.ts`
 * (P4b).
 *
 * Order is insignificant to both consumers except in one place: `clampMode`'s
 * last-resort fallback is `allowed[0]`, so `default` stays first.
 */
export const ALL_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]

/**
 * Shift+Tab cycling order — **what the user actually presses through**. Also
 * deliberately **not** the permissiveness order above: the cycle is UX, and only
 * the hierarchy answers "is this mode wider than that one". Keeping them
 * separate is what lets `forbiddenModes` drop an entry from the cycle without
 * disturbing the ranking that `clampMode` walks.
 *
 * Today this coincides with `ALL_MODES`. They diverge as soon as a mode becomes
 * legal-without-being-cyclable — that divergence is the entire reason there are
 * two arrays, so do not "simplify" one back into the other.
 */
export const MODE_CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

/** 规范形 → 把别名与大小写归一到一个键上（键一律小写）。 */
const MODE_ALIASES: Record<string, PermissionMode> = {
  default: 'default',
  plan: 'plan',
  acceptedits: 'acceptEdits',
  auto: 'auto',
  bypasspermissions: 'bypassPermissions',
  bypass: 'bypassPermissions', // 遗留 3 档名（PermissionLevel 里的 'bypass'）
}

/** 认不出的配置一律按这一档收紧 —— 层级表首位即最严的一档（与 P4 同一真源）。 */
const STRICTEST_MODE: PermissionMode = PERMISSION_MODE_HIERARCHY[0]!

const VALID_MODE_LIST = 'default, plan, acceptEdits, auto, bypassPermissions'

/** 可读的类型名 —— 报错要说清「你给的是个字符串」，而不是只说 invalid。 */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 认得出就返回规范形，认不出返回 undefined（调用方负责告警）。 */
function normalizeModeName(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string') return undefined
  return MODE_ALIASES[value.trim().toLowerCase()]
}

/**
 * 校验并规范化 `permissionRestrictions`。
 *
 * 与 `getInvalidRules()` 同一形状：写错的**规则**一直会被告警，写错的**限制**却不会
 * —— 而限制写错的失效方向是 **fail-open**：`forbiddenModes` 里的错拼一个模式都匹配
 * 不上；`maxAllowedMode` 认不出时 `indexOf` 返回 -1，`if (capIdx >= 0)` 之后整个上限
 * 被跳过。于是配置里一个 typo 就让整条组织级策略静默失效，且无任何提示。
 *
 * `restrictions` 是规范化后的值（别名与大小写归一、认不出的条目剔除）；
 * `invalid` 是逐条可读告警。**只要有任意一条认不出来，就按最严一档封顶** ——
 * 拒绝而不是忽略（忽略就是上面那种 fail-open）。
 *
 * 幂等：已规范化的值再喂一次，`invalid` 必为空（子代理会原样转交一次）。
 */
export function normalizeRestrictions(raw: unknown): {
  restrictions?: PermissionRestrictions
  invalid: string[]
} {
  if (raw === undefined || raw === null) return { restrictions: undefined, invalid: [] }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      restrictions: { maxAllowedMode: STRICTEST_MODE },
      invalid: [`permissionRestrictions is not an object (got ${describeValue(raw)})`],
    }
  }

  const source = raw as Record<string, unknown>
  const invalid: string[] = []
  const forbiddenModes: PermissionMode[] = []
  let maxAllowedMode: PermissionMode | undefined
  let sawForbidden = false
  let sawMaxAllowed = false

  for (const key of Object.keys(source)) {
    if (key !== 'forbiddenModes' && key !== 'maxAllowedMode') {
      invalid.push(
        `permissionRestrictions has an unknown key "${key}"; valid keys: forbiddenModes, maxAllowedMode`,
      )
    }
  }

  if (source.forbiddenModes !== undefined) {
    sawForbidden = true
    if (!Array.isArray(source.forbiddenModes)) {
      invalid.push(
        `permissionRestrictions.forbiddenModes must be an array (got ${describeValue(source.forbiddenModes)})`,
      )
    } else {
      source.forbiddenModes.forEach((entry: unknown, i: number) => {
        const mode = normalizeModeName(entry)
        if (mode) forbiddenModes.push(mode)
        else
          invalid.push(
            `permissionRestrictions.forbiddenModes[${i}] is not a permission mode (${JSON.stringify(entry)}); valid: ${VALID_MODE_LIST}`,
          )
      })
    }
  }

  if (source.maxAllowedMode !== undefined) {
    sawMaxAllowed = true
    const mode = normalizeModeName(source.maxAllowedMode)
    if (mode) maxAllowedMode = mode
    else
      invalid.push(
        `permissionRestrictions.maxAllowedMode is not a permission mode (${JSON.stringify(source.maxAllowedMode)}); valid: ${VALID_MODE_LIST}`,
      )
  }

  if (invalid.length > 0) {
    // fail-closed：认不出来就按最严一档封顶。识别得出的部分照旧保留。
    invalid.push(
      `permissionRestrictions could not be fully parsed → mode pinned to the strictest ("${STRICTEST_MODE}")`,
    )
    const restrictions: PermissionRestrictions = { maxAllowedMode: STRICTEST_MODE }
    if (forbiddenModes.length > 0) restrictions.forbiddenModes = forbiddenModes
    return { restrictions, invalid }
  }

  const restrictions: PermissionRestrictions = {}
  if (sawForbidden) restrictions.forbiddenModes = forbiddenModes
  if (sawMaxAllowed) restrictions.maxAllowedMode = maxAllowedMode
  if (Object.keys(restrictions).length === 0) return { restrictions: undefined, invalid: [] }
  return { restrictions, invalid }
}

/**
 * Resolve which modes are actually permitted given the restrictions.
 *
 * Filtered from `ALL_MODES` (the full legal set), **not** from `MODE_CYCLE` —
 * see `ALL_MODES` for what filtering the cycle would silently do to
 * `bypassPermissions`. `nextMode` re-intersects with the cycle afterwards.
 */
function getAllowedModes(restrictions?: PermissionRestrictions): PermissionMode[] {
  let allowed = [...ALL_MODES]

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
  // The user-facing cycle is `MODE_CYCLE`, narrowed by what the restrictions
  // leave allowed — so reading the *cycle's* order (not `getAllowedModes`'
  // order) is what keeps Shift+Tab on the same path once the two arrays
  // diverge. An off-cycle mode (or one forbidden here) is not `indexOf`-able
  // and falls through to `clampMode`.
  const allowed = getAllowedModes(restrictions)
  const cycle = MODE_CYCLE.filter((m) => allowed.includes(m))
  const idx = cycle.indexOf(current)
  if (idx === -1) {
    // Current mode is not on the allowed cycle — clamp then find next
    return clampMode(current, restrictions)
  }
  return cycle[(idx + 1) % cycle.length]!
}
