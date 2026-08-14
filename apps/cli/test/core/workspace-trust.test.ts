import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import {
  WorkspaceTrust,
  getWorkspaceTrust,
  resetWorkspaceTrust,
} from '../../src/core/workspace-trust'

const TRUST_STORE_PATH = join(homedir(), '.mipham', 'trusted-workspaces.json')

describe('WorkspaceTrust', () => {
  let trust: WorkspaceTrust

  beforeEach(() => {
    // Remove existing trust store for clean state
    try {
      rmSync(TRUST_STORE_PATH, { force: true })
    } catch {}
    resetWorkspaceTrust()
    trust = new WorkspaceTrust()
  })

  afterEach(() => {
    try {
      rmSync(TRUST_STORE_PATH, { force: true })
    } catch {}
  })

  it('starts with empty trust list', () => {
    expect(trust.listTrusted()).toEqual([])
  })

  it('trusts a directory', () => {
    const dir = join(tmpdir(), 'trusted-project')
    mkdirSync(dir, { recursive: true })

    trust.trust(dir)
    expect(trust.isTrusted(dir)).toBe(true)
    expect(trust.listTrusted()).toContain(dir)
  })

  it('untrusts a directory', () => {
    const dir = join(tmpdir(), 'untrust-me')
    mkdirSync(dir, { recursive: true })

    trust.trust(dir)
    expect(trust.isTrusted(dir)).toBe(true)

    trust.untrust(dir)
    expect(trust.isTrusted(dir)).toBe(false)
  })

  it('trusts subdirectories of trusted paths (hierarchical trust)', () => {
    const parent = join(tmpdir(), 'parent-workspace')
    const child = join(parent, 'sub-project')
    mkdirSync(child, { recursive: true })

    trust.trust(parent)
    expect(trust.isTrusted(parent)).toBe(true)
    expect(trust.isTrusted(child)).toBe(true)
  })

  it('does not trust nested git repos under a trusted directory', () => {
    const outer = join(tmpdir(), 'outer-repo')
    const nested = join(outer, 'vendor', 'dep')
    const sibling = join(outer, 'src')
    mkdirSync(nested, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    // Mark outer and the nested dir as separate git-repo roots.
    mkdirSync(join(outer, '.git'), { recursive: true })
    mkdirSync(join(nested, '.git'), { recursive: true })

    trust.trust(outer)
    // Same-repo subdir is still trusted…
    expect(trust.isTrusted(sibling)).toBe(true)
    // …but the nested repo (and anything under it) is isolated.
    expect(trust.isTrusted(nested)).toBe(false)
    expect(trust.isTrusted(join(nested, 'src'))).toBe(false)
  })

  it('does not trust sibling directories', () => {
    const dir1 = join(tmpdir(), 'project-a')
    const dir2 = join(tmpdir(), 'project-b')
    mkdirSync(dir1, { recursive: true })
    mkdirSync(dir2, { recursive: true })

    trust.trust(dir1)
    expect(trust.isTrusted(dir1)).toBe(true)
    expect(trust.isTrusted(dir2)).toBe(false)
  })

  it('does not trust parent of trusted subdirectory', () => {
    const parent = join(tmpdir(), 'outer')
    const child = join(parent, 'inner')
    mkdirSync(child, { recursive: true })

    trust.trust(child)
    expect(trust.isTrusted(child)).toBe(true)
    expect(trust.isTrusted(parent)).toBe(false)
  })

  it('is case-insensitive for trust checks', () => {
    const dir = join(tmpdir(), 'MyProject')
    mkdirSync(dir, { recursive: true })

    trust.trust(dir)
    expect(trust.isTrusted(dir.toUpperCase())).toBe(true)
    expect(trust.isTrusted(dir.toLowerCase())).toBe(true)
  })

  it('does not add duplicate entries', () => {
    const dir = join(tmpdir(), 'no-dup')
    mkdirSync(dir, { recursive: true })

    trust.trust(dir)
    trust.trust(dir)
    trust.trust(dir)
    expect(trust.listTrusted().length).toBe(1)
  })

  it('persists trust store to disk', () => {
    const dir = join(tmpdir(), 'persisted')
    mkdirSync(dir, { recursive: true })

    trust.trust(dir)
    expect(existsSync(TRUST_STORE_PATH)).toBe(true)

    // Create a new instance — should load from disk
    const trust2 = new WorkspaceTrust()
    expect(trust2.isTrusted(dir)).toBe(true)
  })

  it('untrust removes subdirectories too', () => {
    const parent = join(tmpdir(), 'to-remove')
    const child = join(parent, 'nested')
    mkdirSync(child, { recursive: true })

    // Trust child first, then parent — both get explicit entries
    trust.trust(child)
    trust.trust(parent)
    // Parent was added, child already covered by parent's hierarchical trust
    expect(trust.listTrusted()).toHaveLength(2)

    trust.untrust(parent)
    // Both parent and child entries should be removed
    expect(trust.isTrusted(parent)).toBe(false)
    expect(trust.isTrusted(child)).toBe(false)
    expect(trust.listTrusted()).toHaveLength(0)
  })

  it('survives corrupt trust store file', () => {
    mkdirSync(join(homedir(), '.mipham'), { recursive: true })
    writeFileSync(TRUST_STORE_PATH, 'not-valid-json{{{', 'utf-8')

    const fresh = new WorkspaceTrust()
    expect(fresh.listTrusted()).toEqual([])
  })

  it('getStorePath returns the correct path', () => {
    expect(trust.getStorePath()).toBe(TRUST_STORE_PATH)
  })
})

describe('getWorkspaceTrust singleton', () => {
  beforeEach(() => {
    try {
      rmSync(TRUST_STORE_PATH, { force: true })
    } catch {}
    resetWorkspaceTrust()
  })

  it('returns the same instance on repeated calls', () => {
    const a = getWorkspaceTrust()
    const b = getWorkspaceTrust()
    expect(a).toBe(b)
  })

  it('resetWorkspaceTrust creates a new instance', () => {
    const a = getWorkspaceTrust()
    resetWorkspaceTrust()
    const b = getWorkspaceTrust()
    expect(a).not.toBe(b)
  })
})
