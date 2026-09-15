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
 * decide "who is first" without a race. On top of that the file carries the
 * holder's pid, and a lock whose holder is gone is reclaimed.
 *
 * **Why the pid is read back.** An earlier version wrote the pid but never
 * looked at it, on the argument that only SIGKILL could leak a lock and that a
 * refused start is loud and safe while a clobbered day is silent and unsafe.
 * The first half of that is wrong, and `main()` shows why: `createCollector`
 * acquires the lock, and *then* everything that can fail — `listen` (EADDRINUSE
 * on a port squatter or a config typo), decrypting a day that will not open —
 * runs inside a `try` whose catch logs and exits. None of those paths call
 * `shutdown()`, so **any start failure leaks the lock, not just SIGKILL**.
 * Reproduced: a start that fails on EADDRINUSE leaves the file behind, and the
 * next start dies with `LockHeldError` forever. Paired with the unit's
 * `Restart=on-failure` that is an unrecoverable restart loop — and the unit
 * also sets `MemoryMax`, whose OOM path is itself a SIGKILL, so the two
 * interact rather than being independent.
 *
 * The correctness argument the old comment worried about is not that hard, and
 * the parts that are subtle all resolve *towards* refusing to start:
 *   · a live pid ⇒ someone holds it, refuse. No signal is ever sent.
 *   · `EPERM` ⇒ the process exists under another uid ⇒ alive, refuse.
 *   · pid reuse ⇒ `kill` succeeds on an unrelated process, so we refuse. The
 *     cost is a stale lock that needs manual cleanup, i.e. the old behaviour,
 *     reached only in the rare case rather than the common one.
 *   · content we did not write (not empty, not decimal) ⇒ refuse. The only
 *     writer is `#tryAcquire`, so anything else was put there by hand.
 * A clobbered day is still impossible: reclaiming happens only after `kill`
 * has said the holder is gone, and the subsequent `wx` open is still atomic
 * against every other process doing the same thing.
 */
export class InstanceLock {
  #fd: number | undefined
  readonly path: string

  constructor(dataDir: string) {
    this.path = join(dataDir, LOCK_FILE)
  }

  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    if (this.#tryAcquire()) return
    if (!this.#reclaimIfDead()) throw new LockHeldError(this.path)
    // One retry. It can only fail if another process claimed the lock in the
    // gap between the unlink and this open, which is a genuine second instance.
    if (!this.#tryAcquire()) throw new LockHeldError(this.path)
  }

  /** Atomic create-and-claim. False means someone else holds it. */
  #tryAcquire(): boolean {
    try {
      this.#fd = openSync(this.path, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    writeSync(this.#fd, String(process.pid))
    return true
  }

  /**
   * Delete the lock file if its holder is gone. True means "try again".
   *
   * An empty file is treated as reclaimable: `#tryAcquire` creates the file and
   * writes the pid in the next statement, so empty content means the process
   * died in that window. It is a two-syscall window, but the alternative —
   * refusing forever over a file that says nothing — is the exact
   * unrecoverable-startup failure this method exists to remove.
   */
  #reclaimIfDead(): boolean {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf-8').trim()
    } catch {
      // It vanished between the failed open and now. Let the retry decide.
      return true
    }
    if (raw !== '') {
      if (!/^\d+$/.test(raw)) return false
      if (this.#isAlive(Number(raw))) return false
    }
    try {
      unlinkSync(this.path)
      return true
    } catch {
      return false
    }
  }

  /** Signal 0 sends nothing; it only asks the kernel whether the pid exists. */
  #isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // ESRCH is the only answer that means "gone". EPERM means it is there
      // but owned by another user, which is still alive.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
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
