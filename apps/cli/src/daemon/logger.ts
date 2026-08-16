/**
 * Minimal structured JSON logger for the Mipham Code daemon.
 *
 * Emits one JSON object per line to stdout (debug/info) or stderr
 * (warn/error), so logs can be aggregated by the process manager
 * (PM2, systemd, Docker) without ad-hoc string formatting.
 *
 * Usage:
 *   import { logger } from './logger'
 *   logger.info('migrated sessions', { count })
 *   logger.child({ sessionId }).error('prompt failed', { error: err })
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  [key: string]: unknown
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Serialize a value for JSON logging, converting Error to {message, stack}. */
function sanitizeValue(v: unknown): unknown {
  if (v instanceof Error) {
    return { message: v.message, stack: v.stack }
  }
  return v
}

export class Logger {
  constructor(
    private readonly name: string,
    private readonly fields: LogFields = {},
    private readonly minLevel: LogLevel = 'info',
  ) {}

  /** Return a child logger with extra context fields merged in. */
  child(fields: LogFields): Logger {
    return new Logger(this.name, { ...this.fields, ...fields }, this.minLevel)
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (ORDER[level] < ORDER[this.minLevel]) return

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      name: this.name,
      msg,
      ...this.fields,
    }
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        entry[k] = sanitizeValue(v)
      }
    }

    const line = JSON.stringify(entry) + '\n'
    if (level === 'warn' || level === 'error') {
      process.stderr.write(line)
    } else {
      process.stdout.write(line)
    }
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields)
  }

  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields)
  }

  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields)
  }

  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields)
  }
}

/** Shared daemon logger. */
export const logger = new Logger('mipham-daemon')
