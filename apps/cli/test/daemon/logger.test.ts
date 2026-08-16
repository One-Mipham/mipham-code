import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Logger } from '../../src/daemon/logger'

function parseLines(lines: string[]): Record<string, unknown>[] {
  return lines.filter((l) => l.trim()).map((l) => JSON.parse(l))
}

describe('Logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdout: string[]
  let stderr: string[]

  beforeEach(() => {
    stdout = []
    stderr = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk))
      return true
    })
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('emits structured JSON for info to stdout', () => {
    const log = new Logger('test')
    log.info('hello', { count: 3 })
    const entries = parseLines(stdout)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'info', name: 'test', msg: 'hello', count: 3 })
    expect(entries[0]!.ts).toBeDefined()
  })

  it('emits error to stderr with sanitized Error', () => {
    const log = new Logger('test')
    log.error('boom', { error: new Error('kaboom') })
    const entries = parseLines(stderr)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ level: 'error', msg: 'boom' })
    expect((entries[0]!.error as { message: string }).message).toBe('kaboom')
    expect(stdout).toHaveLength(0)
  })

  it('filters debug by default minLevel info', () => {
    const log = new Logger('test')
    log.debug('hidden')
    expect(stdout).toHaveLength(0)
    expect(stderr).toHaveLength(0)
  })

  it('child merges context fields', () => {
    const log = new Logger('test').child({ sessionId: 's1' })
    log.info('hello')
    const entries = parseLines(stdout)
    expect(entries[0]!.sessionId).toBe('s1')
  })
})
