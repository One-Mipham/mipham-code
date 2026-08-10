/**
 * Shim for 'bun:sqlite' using Node.js built-in 'node:sqlite' DatabaseSync.
 *
 * The vitest environment runs under Node.js, but the daemon source code imports
 * from 'bun:sqlite' (Bun's built-in SQLite).  This shim provides a compatible
 * Database class so tests can run without Bun.
 *
 * Node.js 22.5+ includes the 'node:sqlite' module (DatabaseSync) whose API is
 * very close to bun:sqlite.  The main differences:
 *   - bun:sqlite: db.run(sql, params) → { changes, lastInsertRowid }
 *   - node:sqlite: db.prepare(sql).run(params) → { changes, lastInsertRowid }
 *   - bun:sqlite: db.query(sql) returns a Statement
 *   - node:sqlite: db.prepare(sql) returns a StatementSync
 *
 * This shim wraps DatabaseSync to match the bun:sqlite Database interface.
 */
import { DatabaseSync } from 'node:sqlite'

interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export class Database {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  run(sql: string, ...params: unknown[]): RunResult {
    const stmt = this.db.prepare(sql)
    // Support both array-style and variadic params (bun:sqlite compatibility)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (params.length === 1 && Array.isArray(params[0])) {
      return stmt.run(...(params[0] as any[])) as RunResult
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return stmt.run(...(params as any[])) as RunResult
  }

  query(sql: string) {
    return this.db.prepare(sql)
  }

  close(): void {
    this.db.close()
  }
}
