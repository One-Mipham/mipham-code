import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { Aggregator, dayKey, emptyAggregate, type Aggregate } from './aggregate.js'
import { decrypt, encrypt } from './crypto.js'

/**
 * Persistence: one encrypted file per server receipt day.
 *
 * The whole file is encrypted at once rather than event by event. A day's
 * aggregate is on the order of a megabyte, AES-NI does that in a few
 * milliseconds, and per-event encryption would multiply that by the request
 * rate while adding nothing — the file is the unit that is read.
 *
 * Losing the ability to read a day is not a partial failure here, so every
 * write goes through `.tmp` + `rename`: a reader sees the previous contents or
 * the new ones, never a half-written file. `rename` is atomic within a
 * filesystem, which is why the `.tmp` is written beside the target rather than
 * in `/tmp`.
 */

/** Instance mutex. Two collectors writing the same day would silently clobber. */
const LOCK_FILE = 'service.lock'

export interface StoreOptions {
  readonly dataDir: string
  readonly key: Buffer
}

export class LockHeldError extends Error {
  constructor(path: string) {
    super(`another collector instance holds ${path} — refusing to start a second one`)
    this.name = 'LockHeldError'
  }
}

/**
 * An exclusive instance lock, held for the process lifetime.
 *
 * `open` with `wx` is atomic at the kernel level, which is the only way to
 * decide this without a race. A stale lock from a killed process would block
 * every future start, so the alternative — writing a pid and checking it — buys
 * a liveness check at the cost of a much harder correctness argument. The unit
 * file uses `Restart=on-failure` with `KillSignal=SIGTERM`, and the release
 * path runs on both SIGTERM and normal exit; SIGKILL is the residual, and it
 * requires manual cleanup. That is the honest trade, recorded rather than
 * hidden: a refused start is loud and safe, a clobbered day is silent and not.
 */
export class InstanceLock {
  #fd: number | undefined
  readonly path: string

  constructor(dataDir: string) {
    this.path = join(dataDir, LOCK_FILE)
  }

  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    try {
      this.#fd = openSync(this.path, 'wx', 0o600)
      writeSync(this.#fd, String(process.pid))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LockHeldError(this.path)
      throw error
    }
  }

  release(): void {
    if (this.#fd === undefined) return
    closeSync(this.#fd)
    this.#fd = undefined
    try {
      unlinkSync(this.path)
    } catch {
      /* already gone */
    }
  }
}

export class AggregateStore {
  readonly #dataDir: string
  readonly #key: Buffer
  readonly #aggregateDir: string
  /** Day currently held in memory. A rollover starts a fresh aggregator. */
  #day: string
  #aggregator: Aggregator
  #dirty = 0

  constructor(options: StoreOptions) {
    this.#dataDir = options.dataDir
    this.#key = options.key
    this.#aggregateDir = join(options.dataDir, 'aggregate')
    this.#day = dayKey(new Date())
    this.#aggregator = this.#load(this.#day)
  }

  get day(): string {
    return this.#day
  }

  get aggregator(): Aggregator {
    return this.#aggregator
  }

  /** Pending changes since the last successful flush. */
  get dirty(): number {
    return this.#dirty
  }

  noteDirty(): void {
    this.#dirty++
  }

  pathForDay(day: string): string {
    return join(this.#aggregateDir, `${day}.json.enc`)
  }

  #load(day: string): Aggregator {
    const path = this.pathForDay(day)
    try {
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(decrypt(raw, this.#key)) as Aggregate
      // The day in the file is authoritative for what it claims to be; a
      // mismatch means the file was moved or renamed by hand, and aggregating
      // it under its new name would corrupt both days.
      if (parsed.day !== day) {
        throw new Error(`${path} claims day ${parsed.day} — refusing to load it as ${day}`)
      }
      return new Aggregator(day, parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Aggregator(day, emptyAggregate(day))
      }
      // Anything else — wrong key, corrupt body, truncated file — is re-raised.
      // Starting a fresh aggregator would overwrite a day that may still be
      // recoverable, turning a decryption problem into permanent data loss.
      throw error
    }
  }

  /**
   * Write the current day, if anything has changed.
   *
   * Returns true when a write happened, false when there was nothing to write.
   * A failed write **throws** — deliberately, and the caller depends on it:
   * `server.ts` flushes on the request path *before* sending the 204, so a throw
   * becomes a 500, and a 500 is the one status that makes the client keep the
   * event queued. Swallowing it here would ack data that was never written and
   * that nothing will ever retry, turning a full disk into silent loss.
   */
  flush(now = new Date()): boolean {
    const today = dayKey(now)
    let wrote = false

    if (today !== this.#day) {
      // Seal the finished day first, so a crash after the rollover cannot lose
      // it — the new day's aggregator starts empty and the old one is gone.
      wrote = this.#write(this.#day, this.#aggregator)
      this.#day = today
      this.#aggregator = this.#load(today)
      this.#dirty = 0
      return wrote
    }

    if (this.#dirty === 0) return false
    return this.#write(this.#day, this.#aggregator)
  }

  #write(day: string, aggregator: Aggregator): boolean {
    mkdirSync(this.#aggregateDir, { recursive: true, mode: 0o700 })
    const path = this.pathForDay(day)
    const tmp = `${path}.tmp`
    const body = encrypt(JSON.stringify(aggregator.toState()), this.#key)
    writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, path)
    this.#dirty = 0
    return true
  }

  /** Days with a file on disk, oldest first. */
  availableDays(): string[] {
    try {
      return readdirSync(this.#aggregateDir)
        .filter((name) => name.endsWith('.json.enc'))
        .map((name) => name.replace(/\.json\.enc$/, ''))
        .sort()
    } catch {
      return []
    }
  }

  /** Read one day without touching in-memory state. Used by `report.ts`. */
  readDay(day: string): Aggregate {
    return JSON.parse(decrypt(readFileSync(this.pathForDay(day), 'utf-8'), this.#key)) as Aggregate
  }
}
