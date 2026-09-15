/**
 * The wire contract, as the collector understands it.
 *
 * Zero imports on purpose: everything else in this app depends on this file, so
 * keeping it dependency-free is what makes the contract auditable in one read.
 *
 * The producer side lives in `apps/cli/src/telemetry/` (`payload.ts` for the
 * session event, `crash.ts` for the crash event). Those two files and this one
 * are the only places the shape is defined, and
 * `apps/cli/test/integrity/telemetry-contract.test.ts` fails if they drift —
 * without that test, renaming one payload field on the client would make every
 * event permanently and silently 400 at the collector.
 */

/** Shape version this collector knows how to aggregate. */
export const SCHEMA_VERSION_V1 = 1

/**
 * The version the client will move to when it stops sending `stackFrames`.
 *
 * Listed here from day one even though no client emits it yet: the collector
 * deploys *before* the client change (that ordering is mandatory — a client that
 * stopped sending frames to a collector that could not parse its events would
 * lose them all), so listing it early costs nothing and spares the `unknownSchema`
 * counter a burst of false positives on the day v2 ships.
 */
export const SCHEMA_VERSION_V2 = 2

/**
 * Versions accepted without rejection.
 *
 * The collector must never reject an unknown version. Deployment lags release:
 * a client shipping v3 while the collector still lists only v2 would have every
 * event from every user discarded, silently, until an unrelated deploy caught
 * up. Unknown versions are counted (`unknownSchema`) and aggregated by the
 * fields we do recognise — which is a smaller lie than losing them.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [SCHEMA_VERSION_V1, SCHEMA_VERSION_V2]

/**
 * Event discriminators.
 *
 * An unrecognised kind is **not** a rejection: the event is acked (204), counted
 * as `unknownKind`, and contributes to no dimension. Rejecting it would be a 4xx
 * — which the client treats as permanent and silently deletes — and it would buy
 * nothing, since a well-formed future kind means a *newer* client, not a broken
 * one.
 */
export const EVENT_KINDS = ['session', 'crash'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/**
 * Counter families cleared for collection, as they arrive in the payload.
 *
 * These are the client's whitelist entries with the `mipham_code_` prefix and
 * `_total` suffix already stripped by `snapshotCounters()`. Anything outside
 * this set is folded into `unknownFamily`, never stored under its own name.
 */
export const COUNTER_FAMILIES = [
  'cli_invocations',
  'command_calls',
  'tool_calls',
  'crsi_rule_applications',
  'sis_interceptions',
] as const
export type CounterFamily = (typeof COUNTER_FAMILIES)[number]

/**
 * Crash origins the client can report.
 *
 * A closed set, and deliberately not extensible by the client: an unbounded
 * `origin` is the same cardinality hole that `command_name` turned out to be.
 */
export const CRASH_ORIGINS = ['uncaughtException', 'unhandledRejection', 'render'] as const
export type CrashOrigin = (typeof CRASH_ORIGINS)[number]

/**
 * Error names kept as their own dimension.
 *
 * JavaScript's own error classes plus the handful of Node/DOM ones a CLI
 * genuinely throws. This list is **not** a port of the Python collector's
 * `ERROR_NAMES` (`schema.py`) — that one enumerates Python exceptions and would
 * fold every real JavaScript error into `__other__`. Anything not listed is
 * folded, so the dimension stays bounded no matter what a client sends.
 */
export const ERROR_NAMES = [
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AggregateError',
  'AssertionError',
  'AbortError',
  'TimeoutError',
] as const

/** Fold-in bucket for any label or enum value outside the closed sets. */
export const OTHER = '__other__'

/**
 * Reserved bucket for MCP tool calls.
 *
 * MCP tool names are `mcp__<server>__<tool>`, chosen by whatever servers a user
 * configured — unbounded, per-user, and unknowable at build time, so no static
 * allowlist can hold them. They are nonetheless *expected* traffic, which is
 * why they must not share a bucket with junk: `__other__` earns its keep only
 * by being a signal that something is wrong (an unrecognised tool, an attacker
 * probing the dimension), and it cannot be that signal if normal use keeps it
 * permanently non-zero.
 *
 * Recorded but never enumerated — the *count* of MCP usage is kept, the server
 * and tool names are not.
 */
export const OTHER_MCP = '__mcp__'

/** Prefix identifying a tool name as belonging to an MCP server. */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * Produced by `runtimeTag()`, which is **asymmetric on purpose**: Node reports
 * its major only (`node@22`), Bun reports the full version (`bun@1.2.3`).
 *
 * A `\d+` pattern was wrong here and the mistake is instructive: it accepted the
 * Node form and rejected the Bun form, and Bun is the CLI's *recommended*
 * runtime — so `runtime` would have been silently dropped from every event of
 * the majority population, leaving `byRuntime` empty with every test still
 * green. `apps/cli/test/integrity/telemetry-contract.test.ts` now feeds a real
 * `runtimeTag()` output through this pattern, which is what surfaced it.
 */
export const RUNTIME_PATTERN = /^(bun|node)@\d+(\.\d+)*$/

/** `darwin/arm64`, `linux/x64`. Produced by `platformTag()`. */
export const PLATFORM_PATTERN = /^[a-z0-9]+\/[a-z0-9]+$/

/** sha256 of the error message, first 16 hex chars. Produced by `hashMessage()`. */
export const MESSAGE_HASH_PATTERN = /^[0-9a-f]{16}$/

/** `application/json`, matched case-insensitively and with parameters. */
export const JSON_CONTENT_TYPE_PATTERN = /^application\/json\b/i

/**
 * Largest body the collector will read.
 *
 * Mirrors nginx's `client_max_body_size 64k` in `deploy/nginx/log.onemipham.com.conf`,
 * which is where the limit is actually enforced — nginx rejects an oversized
 * body with 413 before it is read. This constant exists so the application also
 * refuses when it is reached directly (127.0.0.1:9099, tests, a future proxy
 * change), rather than trusting the layer in front of it to be there.
 *
 * Same figure as `miphamai4s`'s `sender.py` `MAX_BODY_BYTES`; a real session
 * event is a few hundred bytes and a crash event a few kilobytes, so this is
 * two orders of magnitude of headroom.
 */
export const MAX_BODY_BYTES = 64 * 1024

/** Largest counter value accepted before clamping. */
export const MAX_COUNTER_VALUE = 1_000_000

/** Longest string kept for a dimension value that is stored verbatim. */
export const MAX_DIMENSION_LENGTH = 64
