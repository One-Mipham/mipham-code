/**
 * Where telemetry is sent.
 *
 * This module is the source of truth for the *destination contract*: the path
 * below has to match the `location =` block in
 * `apps/telemetry/deploy/nginx/log.onemipham.com.conf`. A drift between the two
 * is not a loud failure — every event gets a 404, the client treats 4xx as
 * "permanently unacceptable" and deletes it, and telemetry quietly becomes a
 * no-op for everyone. `apps/cli/test/integrity/telemetry-contract.test.ts` is
 * the mechanical defence against that, which is why the constant lives in a
 * module of its own: the test needs to import exactly one file.
 */

/**
 * The hosted receiver. Public, write-only, unauthenticated: the CLI cannot hold
 * a secret (it ships to npm as Apache-2.0 source), so this address is designed
 * to be useless to anyone who finds it — aggregate dimensions only, no readback.
 */
export const OFFICIAL_TELEMETRY_ENDPOINT = 'https://log.onemipham.com/v1/events'

/**
 * Opt in *and* send nowhere.
 *
 * Without this there is no way to express that state. Resolution is
 * `env || user || default` and an empty string is falsy, so `endpoint: ""`
 * falls *through* to the next tier instead of clearing the destination. Before
 * T1b the default was empty and the two were indistinguishable; now the default
 * is a real URL, so an empty override would silently start sending. `none`
 * keeps the capability: self-hosted installs and internal-network audits that
 * want telemetry recorded locally but nothing leaving the machine.
 *
 * Exact match only, the same rule as `MIPHAM_TELEMETRY=off`.
 */
export const NO_ENDPOINT = 'none'

/**
 * Which tier supplied the destination.
 *
 * `off` is not in this union: it is not a destination that was resolved at all,
 * it is the hard kill switch firing before resolution. `TelemetryConsent`
 * widens the type for that case.
 */
export type EndpointSource = 'env' | 'user' | 'default'

export interface ResolvedEndpoint {
  /** Destination. Empty means nothing is ever sent. */
  endpoint: string
  source: EndpointSource
}

/**
 * Resolve the destination, first match wins:
 *
 *   1. `MIPHAM_TELEMETRY_ENDPOINT`
 *   2. user `settings.json` → `telemetry.endpoint`
 *   3. {@link OFFICIAL_TELEMETRY_ENDPOINT}
 *
 * {@link NO_ENDPOINT} at any winning tier resolves to an empty destination, and
 * still reports the tier that supplied it — "which tier decided" and "did it
 * decide to send" are separate questions, and `/telemetry status` answers both.
 */
export function resolveEndpoint(
  userEndpoint: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEndpoint {
  const fromEnv = env.MIPHAM_TELEMETRY_ENDPOINT
  const raw = fromEnv || userEndpoint || OFFICIAL_TELEMETRY_ENDPOINT
  return {
    endpoint: raw === NO_ENDPOINT ? '' : raw,
    source: fromEnv ? 'env' : userEndpoint ? 'user' : 'default',
  }
}

/**
 * Host of the official receiver, for user-facing copy.
 *
 * Derived rather than retyped: the first-run prompt names the destination, and
 * a hard-coded second copy of it would keep naming the old host after a move.
 */
export function officialEndpointHost(): string {
  return new URL(OFFICIAL_TELEMETRY_ENDPOINT).host
}
