import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TokenStore } from '../../src/mcp/token-store'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('TokenStore', () => {
  let store: TokenStore
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-tokens-test-${Date.now()}`)
    store = new TokenStore(testDir)
  })

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it('saves and loads tokens', () => {
    store.save('test-server', {
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
      expiresAt: '2026-09-07T10:00:00Z',
      scopes: ['tools.read'],
    })
    const loaded = store.load('test-server')
    expect(loaded).not.toBeNull()
    expect(loaded!.accessToken).toBe('access-abc')
    expect(loaded!.refreshToken).toBe('refresh-xyz')
  })

  it('encrypts tokens at rest', () => {
    store.save('test-server', {
      accessToken: 'secret-token',
      refreshToken: 'secret-refresh',
      expiresAt: '2026-09-07T10:00:00Z',
    })
    const { readFileSync } = require('node:fs')
    const raw = readFileSync(join(testDir, 'test-server.enc'), 'utf-8')
    expect(raw).not.toContain('secret-token')
    expect(raw).not.toContain('secret-refresh')
  })

  it('returns null for missing server', () => {
    expect(store.load('nonexistent')).toBeNull()
  })

  it('deletes tokens', () => {
    store.save('to-delete', {
      accessToken: 'x',
      expiresAt: '2026-09-07T10:00:00Z',
    })
    store.delete('to-delete')
    expect(store.load('to-delete')).toBeNull()
  })

  it('lists all stored servers', () => {
    store.save('server-a', {
      accessToken: 'a',
      expiresAt: '2026-09-07T10:00:00Z',
    })
    store.save('server-b', {
      accessToken: 'b',
      expiresAt: '2026-09-07T10:00:00Z',
    })
    const list = store.list()
    expect(list).toContain('server-a')
    expect(list).toContain('server-b')
  })

  it('creates directory on first save', () => {
    const nested = join(testDir, 'nested', 'deep')
    const nestedStore = new TokenStore(nested)
    nestedStore.save('srv', {
      accessToken: 't',
      expiresAt: '2026-09-07T10:00:00Z',
    })
    expect(existsSync(nested)).toBe(true)
  })

  it('sets file permissions to 600 on Unix', () => {
    store.save('perm-test', {
      accessToken: 't',
      expiresAt: '2026-09-07T10:00:00Z',
    })
    const { statSync } = require('node:fs')
    const stat = statSync(join(testDir, 'perm-test.enc'))
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })
})
