import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { KeyError, loadKey } from './crypto.js'

/**
 * Runtime configuration, entirely from the environment.
 *
 * The systemd unit supplies these via `EnvironmentFile=/etc/mipham-telemetry/telemetry.env`
 * (mode 0600, root-owned), so there is no config file parser here and no
 * precedence rules to reason about — one source, one order.
 *
 * **No secret is ever a default.** The encryption key is read from a path, not
 * from a variable, so it cannot be captured in `systemctl show` output or in a
 * process listing. An env var holding key material would leak into both.
 */

export interface Config {
  /** Loopback only. nginx terminates TLS and proxies here. */
  readonly host: string
  readonly port: number
  /** State root: the lock file and the `aggregate/` directory live here. */
  readonly dataDir: string
  /** 32-byte key file, mode 0400. */
  readonly keyPath: string
  /**
   * The one hostname this service answers to, used only to *count* requests
   * that arrive under a different one.
   *
   * nginx's `server_name` is what actually enforces this; the application check
   * is observation, never refusal. Refusing would be a 4xx, and a 4xx is a
   * silent permanent delete on the client — triggered by nothing worse than a
   * health checker using an IP literal.
   */
  readonly canonicalHost: string
  /** Events accepted before a flush is forced. */
  readonly flushEvery: number
  /** Milliseconds between periodic flushes, when there is something to write. */
  readonly flushIntervalMs: number
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.MIPHAM_TELEMETRY_HOST || '127.0.0.1',
    port: intFromEnv('MIPHAM_TELEMETRY_PORT', 9099),
    dataDir: env.MIPHAM_TELEMETRY_DATA_DIR || '/var/lib/mipham-telemetry',
    keyPath: env.MIPHAM_TELEMETRY_KEY_PATH || '/etc/mipham-telemetry/aggregate.key',
    canonicalHost: env.MIPHAM_TELEMETRY_CANONICAL_HOST || 'log.onemipham.com',
    flushEvery: intFromEnv('MIPHAM_TELEMETRY_FLUSH_EVERY', 25),
    flushIntervalMs: intFromEnv('MIPHAM_TELEMETRY_FLUSH_INTERVAL_MS', 10_000),
  }
}

/**
 * Refuse to start when encrypted history exists but its key does not.
 *
 * This is the one startup check that is not merely defensive. Without it the
 * service would come up perfectly healthy against an empty aggregate directory
 * — because every read would find nothing to read — and the loss of the entire
 * history would present as a normal start. Writing a fresh key on the miss
 * would be worse still: it would make yesterday's files permanently unreadable
 * while looking like a clean beginning.
 *
 * The reverse is fine and expected: a key with no data is a fresh install.
 */
export function assertKeyPresentWhenHistoryExists(config: Config): void {
  if (existsSync(config.keyPath)) return

  const aggregateDir = join(config.dataDir, 'aggregate')
  const history = existsSync(aggregateDir)
    ? readdirSync(aggregateDir).filter((name) => name.endsWith('.json.enc'))
    : []

  if (history.length > 0) {
    throw new KeyError(
      `${config.keyPath} is missing but ${history.length} encrypted aggregate file(s) exist in ` +
        `${aggregateDir} (oldest: ${history[0]}). Refusing to start: without the key this history ` +
        `cannot be read, and generating a new one would make that permanent.`,
    )
  }
}

/** Load the key, or `undefined` when this is a fresh install with no history. */
export function loadKeyIfPresent(config: Config): Buffer | undefined {
  if (!existsSync(config.keyPath)) return undefined
  return loadKey(config.keyPath)
}
