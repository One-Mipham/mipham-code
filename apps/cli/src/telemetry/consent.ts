import { randomUUID } from 'node:crypto'
import {
  readSettingsDoc,
  writeSettingsDoc,
  settingsPathFor,
  projectFilePath,
} from '../config/loader'
import { resolveEndpoint, type EndpointSource } from './endpoint'
import { miphamHome } from '../core/paths.ts'

/**
 * Consent for telemetry.
 *
 * The switch deliberately lives in `settings.json`, not `config.yml`, for two
 * independent reasons — either alone would disqualify config.yml:
 *
 *   1. First-run setup is detected by pure file existence
 *      (`index.tsx` `needsSetup = !hasUserConfig && !hasProjectConfig`). Writing
 *      config.yml on first run would make the setup wizard never appear again.
 *   2. config.yml merges shallowly (`config/loader.ts` `{ ...base, ...override }`;
 *      only `mergeProviders` deep-merges). Adding a `telemetry:` key would knock
 *      out the defaults of every sibling table.
 *
 * `settings.json` is the only config writer in the repo that preserves keys it
 * does not model.
 */

/** The shape we persist under `settings.json`'s `telemetry` key. */
export interface TelemetrySettings {
  enabled?: boolean
  endpoint?: string
  installId?: string
  promptedAt?: string
}

/** Why telemetry ended up on or off — surfaced by `/telemetry status`. */
export type ConsentSource = 'env-off' | 'project-veto' | 'user-optin' | 'default-off'

/**
 * 项目级文件里**写了、但按设计不采纳**的键。
 *
 * 只有这两档词汇：`enabled: true`（项目不能授予同意）与非空 `endpoint`（项目不能选
 * 目的地）。`installId` / `promptedAt` 不在内 —— 那两键由本工具写进**用户**文件，
 * 出现在项目文件里是「键写错了」，报成「一档被拒绝」只会把人引偏。
 */
export type ProjectIgnoredKey = 'enabled' | 'endpoint'

export interface TelemetryConsent {
  enabled: boolean
  endpoint: string
  source: ConsentSource
  /**
   * Which tier supplied `endpoint` — `env`, `user`, or the shipped `default`.
   * `off` when the hard kill switch fired first and no destination was resolved
   * at all. Kept separate from `source` because "who decided whether to
   * collect" and "who decided where to send" are different questions, and a
   * user debugging an unexpected destination needs the second one.
   */
  endpointSource: EndpointSource | 'off'
  /**
   * 项目级文件里声明了、而**没有生效**的键（按 `enabled` → `endpoint` 固定序）。
   *
   * 为什么要有这个名单：「按设计不采纳」与「压根没读你的文件」从外面看是**同一片
   * 沉默**，而这是用户自己写下的字，就在他还能看见的那个文件里。兄弟形状见
   * `config/loader.ts` 的 `projectModeSkipped` —— 同一条理由，同一句公告。
   *
   * 为什么不干脆采纳：项目这一档只许**收紧**（`enabled: false` 是否决）。采纳
   * `endpoint` 等于克隆一个仓库就把用户已 opt-in 的遥测改道到仓库指定的收集器，
   * 与「项目不能授予同意」是同一件事的两种写法。
   *
   * 空串不算声明 —— 名单要说的是「你写了 X 而它不生效」，不是「这个键存在过」。
   */
  ignoredProjectKeys: ProjectIgnoredKey[]
}

/** 项目文件里声明了这两档词汇的那些键（顺序固定，与文件里的书写顺序无关）。 */
function declaredProjectKeys(project: TelemetrySettings): ProjectIgnoredKey[] {
  const keys: ProjectIgnoredKey[] = []
  if (project.enabled === true) keys.push('enabled')
  if (typeof project.endpoint === 'string' && project.endpoint !== '') keys.push('endpoint')
  return keys
}

/**
 * Hard kill switch. Its semantics are deliberately stronger than "do not send":
 * nothing is collected, no queue file is created, and there is no network call.
 * Only the exact value `off` is recognised — `MIPHAM_TELEMETRY=1` is *not*
 * consent (see `resolveTelemetry`).
 */
export function isHardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MIPHAM_TELEMETRY === 'off'
}

/**
 * Read the `telemetry` block of one settings.json scope.
 *
 * `readSettingsDoc` *throws* on a malformed file (by design — it refuses to
 * clobber a file holding the user's other settings). Telemetry must never take
 * the CLI down, and must fail closed: a broken settings.json means "off".
 */
export function readTelemetrySettings(
  scope: 'user' | 'project',
  cwd: string = process.cwd(),
): TelemetrySettings {
  try {
    const doc = readSettingsDoc(settingsPathFor(scope, cwd))
    const block = doc.telemetry
    if (!block || typeof block !== 'object' || Array.isArray(block)) return {}
    return block as TelemetrySettings
  } catch {
    return {}
  }
}

/**
 * Decide whether to collect, and where to send.
 *
 * The two are resolved independently. Having a destination is not consent to
 * send to it (see `resolveEndpoint` for the destination chain, including the
 * `none` sentinel); `endpointSource` reports which tier supplied it.
 *
 * Three tiers, fail-closed:
 *   1. `MIPHAM_TELEMETRY=off` — hard off, overrides everything.
 *   2. user `settings.json` `telemetry.enabled === true` — the user's own consent.
 *   3. project `settings.json` `telemetry.enabled === false` — **veto only**.
 *
 * Tier 3 is asymmetric on purpose: a project must not be able to *grant*
 * consent, or cloning a repository would be equivalent to that repository
 * consenting on the user's behalf. Same shape as the existing
 * `permissionRestrictions` fail-closed downgrade.
 *
 * **The withholding is reported, not silent.** A project that declared
 * `enabled: true` or a destination gets those keys named back to it in
 * `ignoredProjectKeys` — from the outside, "ignored on purpose" and "never read
 * your file" are the same silence, and the user is the one who wrote those
 * lines, in a file they can still see.
 *
 * There is intentionally no env var that grants consent. Consent has to be a
 * persistent, deliberate act (the first-run prompt or `/telemetry on`) — env
 * vars are inherited by child processes and end up in CI logs, so they must not
 * be a channel for consent-by-proxy.
 *
 * **There is no tier 3 at all when running from `~`.** There the project path and
 * the user path name the same file, so applying tier 3 would withhold the user's
 * *own* consent. That case skips the read rather than re-labelling it — see
 * `projectFilePath`.
 */
export function resolveTelemetry(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): TelemetryConsent {
  // The kill switch is resolved first and reads no file at all — so there is no
  // project-tier declaration to report here, not even an unread one.
  if (isHardDisabled(env)) {
    return {
      enabled: false,
      endpoint: '',
      source: 'env-off',
      endpointSource: 'off',
      ignoredProjectKeys: [],
    }
  }

  const user = readTelemetrySettings('user', cwd)
  // Absent — not "read and hollowed out" — when the project scope *is* the user
  // scope, i.e. the CLI is running from the home directory itself (see
  // `projectFilePath`). Reading it anyway would file the user's own opt-in as a
  // repository declaration: withheld here, and then named back to them in the
  // warning as the very file to go set it in.
  const project =
    projectFilePath('settings.json', cwd) === null ? {} : readTelemetrySettings('project', cwd)
  const { endpoint, source: endpointSource } = resolveEndpoint(user.endpoint, env)
  const ignoredProjectKeys = declaredProjectKeys(project)

  if (project.enabled === false) {
    return { enabled: false, endpoint, source: 'project-veto', endpointSource, ignoredProjectKeys }
  }
  if (user.enabled === true) {
    return { enabled: true, endpoint, source: 'user-optin', endpointSource, ignoredProjectKeys }
  }
  return { enabled: false, endpoint, source: 'default-off', endpointSource, ignoredProjectKeys }
}

function patchUserTelemetry(patch: TelemetrySettings, cwd: string): void {
  const path = settingsPathFor('user', cwd)
  const doc = readSettingsDoc(path)
  const block = doc.telemetry
  const current: TelemetrySettings =
    block && typeof block === 'object' && !Array.isArray(block) ? (block as TelemetrySettings) : {}
  doc.telemetry = { ...current, ...patch }
  writeSettingsDoc(path, doc)
}

/**
 * The anonymous install id.
 *
 * Generated on first use, persisted to the *user* scope so it is stable across
 * projects. It is not an identity: it is not derived from, nor joined to, any
 * account, machine fingerprint, hostname or MAC address — it is a bare random
 * UUID. `/telemetry reset-id` replaces it.
 */
export function getOrCreateInstallId(cwd: string = process.cwd()): string {
  const existing = readTelemetrySettings('user', cwd).installId
  if (typeof existing === 'string' && existing.length > 0) return existing
  const id = randomUUID()
  try {
    patchUserTelemetry({ installId: id }, cwd)
  } catch {
    // Read-only HOME: report under an ephemeral id rather than fail the session.
  }
  return id
}

export function resetInstallId(cwd: string = process.cwd()): string {
  const id = randomUUID()
  patchUserTelemetry({ installId: id }, cwd)
  return id
}

/** Persist the user's answer from `/telemetry on|off`. */
export function setTelemetryEnabled(enabled: boolean, cwd: string = process.cwd()): void {
  patchUserTelemetry({ enabled }, cwd)
}

/**
 * Endpoint override, persisted by `/telemetry endpoint <url>`.
 *
 * `none` is accepted and stored like any other value: the sentinel is
 * interpreted at resolution time (`resolveEndpoint`), not at write time.
 */
export function setTelemetryEndpoint(endpoint: string, cwd: string = process.cwd()): void {
  patchUserTelemetry({ endpoint }, cwd)
}

/**
 * The prompt is one-shot per machine, tracked by a marker *separate* from
 * `enabled` — otherwise "asked and declined" and "never asked" would be
 * indistinguishable and the question would reappear forever.
 */
export function wasPrompted(cwd: string = process.cwd()): boolean {
  const marker = readTelemetrySettings('user', cwd).promptedAt
  return typeof marker === 'string' && marker.length > 0
}

export function markPrompted(cwd: string = process.cwd(), now: Date = new Date()): void {
  try {
    patchUserTelemetry({ promptedAt: now.toISOString() }, cwd)
  } catch {
    /* read-only HOME — the prompt may reappear, which is benign */
  }
}

/**
 * Whether it is safe to ask. A non-TTY (piped, daemon, CI) gets no prompt: it
 * would block on input that can never arrive. Those runs stay opted out and
 * still record the marker, so nothing is asked twice.
 */
export function isInteractive(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean | undefined = process.stdout.isTTY,
): boolean {
  if (env.CI) return false
  if (env.MIPHAM_NON_INTERACTIVE === '1') return false
  return isTTY === true
}

/** `~/.mipham/telemetry` — the queue directory. */
export function telemetryDir(): string {
  return miphamHome('telemetry')
}
