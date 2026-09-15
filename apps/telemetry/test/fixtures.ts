/**
 * Wire fixtures, shaped exactly as `apps/cli/src/telemetry/{payload,crash}.ts`
 * produce them.
 *
 * Hand-written rather than imported from the CLI on purpose. Importing
 * `buildSessionEvent` would make these tests depend on the CLI's module graph
 * (ink, react, the provider registry), and — more importantly — it would make
 * them agree with the client *by construction*, so a client-side rename would
 * move both sides together and the suite would stay green while the collector
 * silently dropped a field. The cross-app check is
 * `apps/cli/test/integrity/telemetry-contract.test.ts`, which is the one place
 * that imports both. These fixtures are the collector's independent idea of the
 * shape, and the two disagreeing is the signal.
 */

/** Values distinctive enough to grep for in a decrypted aggregate file. */
export const INSTALL_ID = 'fixture-install-id-9f8e7d6c'
export const SECOND_INSTALL_ID = 'fixture-install-id-1a2b3c4d'
export const MESSAGE_HASH = 'a1b2c3d4e5f60718'

/**
 * Strings a privacy test searches the *stored* bytes for. They appear in the
 * payloads below and must appear nowhere on disk.
 */
export const FRAME_SENTINEL = 'SENTINELSTACKFRAMESTRING'
export const MESSAGE_SENTINEL = 'sentinel message text that must never be stored'

export interface FixtureEvent {
  id: string
  kind: string
  payload: Record<string, unknown>
}

/** A `session` event, as `buildSessionEvent()` shapes it. */
export function sessionEvent(
  overrides: Partial<Record<string, unknown>> = {},
  envelope: Partial<Pick<FixtureEvent, 'id' | 'kind'>> = {},
  now: Date = new Date(),
): FixtureEvent {
  return {
    id: envelope.id ?? 'fixture-session-0001',
    kind: envelope.kind ?? 'session',
    payload: {
      installId: INSTALL_ID,
      schemaVersion: 1,
      occurredAt: now.toISOString(),
      appVersion: '0.81.6',
      // Asymmetric on purpose: Bun reports a full version, Node only its major.
      runtime: 'bun@1.2.3',
      platform: 'darwin/arm64',
      sessionDurationMs: 120_000,
      crashed: false,
      counters: {
        cli_invocations: 1,
        'command_calls./help': 1,
        'tool_calls.Read': 3,
        'tool_calls.mcp__github__search': 2,
        crsi_rule_applications: 4,
        sis_interceptions: 0,
      },
      ...overrides,
    },
  }
}

/** A `crash` event, as `buildCrashEvent()` shapes it. Note: no `counters`. */
export function crashEvent(
  overrides: Partial<Record<string, unknown>> = {},
  envelope: Partial<Pick<FixtureEvent, 'id' | 'kind'>> = {},
  now: Date = new Date(),
): FixtureEvent {
  return {
    id: envelope.id ?? 'fixture-crash-0001',
    kind: envelope.kind ?? 'crash',
    payload: {
      installId: INSTALL_ID,
      schemaVersion: 1,
      occurredAt: now.toISOString(),
      appVersion: '0.81.6',
      runtime: 'node@22',
      platform: 'linux/x64',
      errorName: 'TypeError',
      messageHash: MESSAGE_HASH,
      stackFrames: [FRAME_SENTINEL, 'at foo (SENTINELSTACKFRAMESTRING:1:1)'],
      frameCount: 2,
      origin: 'uncaughtException',
      ...overrides,
    },
  }
}
