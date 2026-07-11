import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArtifactVersioning } from '../../src/artifacts/versioning'

let tmpDir: string
let versioning: ArtifactVersioning

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mipham-artifact-versioning-'))
  versioning = new ArtifactVersioning(tmpDir)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── saveVersion ──

describe('saveVersion', () => {
  it('returns 1 for the first save', () => {
    const v = versioning.saveVersion('chart', '<html></html>')
    expect(v).toBe(1)
  })

  it('returns incrementing version numbers', () => {
    expect(versioning.saveVersion('chart', 'v1')).toBe(1)
    expect(versioning.saveVersion('chart', 'v2')).toBe(2)
    expect(versioning.saveVersion('chart', 'v3')).toBe(3)
  })

  it('writes version files to disk', () => {
    versioning.saveVersion('chart', '<svg></svg>')
    const vPath = join(tmpDir, 'chart', 'versions', 'v1.html')
    expect(existsSync(vPath)).toBe(true)
    expect(readFileSync(vPath, 'utf-8')).toBe('<svg></svg>')
  })

  it('updates current.html on every save', () => {
    versioning.saveVersion('chart', 'first')
    versioning.saveVersion('chart', 'second')
    const current = readFileSync(join(tmpDir, 'chart', 'current.html'), 'utf-8')
    expect(current).toBe('second')
  })

  it('writes a manifest.json', () => {
    versioning.saveVersion('chart', 'content')
    const manifestPath = join(tmpDir, 'chart', 'manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(manifest.name).toBe('chart')
    expect(manifest.currentVersion).toBe(1)
    expect(manifest.versionCount).toBe(1)
  })

  it('handles multiple artifacts independently', () => {
    versioning.saveVersion('chart-a', 'a-v1')
    versioning.saveVersion('chart-b', 'b-v1')
    versioning.saveVersion('chart-a', 'a-v2')

    expect(versioning.saveVersion('chart-a', 'a-v3')).toBe(3)
    expect(versioning.saveVersion('chart-b', 'b-v2')).toBe(2)
  })
})

// ── listVersions ──

describe('listVersions', () => {
  it('returns empty array for non-existent artifact', () => {
    expect(versioning.listVersions('nonexistent')).toEqual([])
  })

  it('returns versions sorted by version descending', () => {
    versioning.saveVersion('chart', 'v1')
    versioning.saveVersion('chart', 'v2')
    versioning.saveVersion('chart', 'v3')

    const versions = versioning.listVersions('chart')
    expect(versions).toHaveLength(3)
    expect(versions[0]!.version).toBe(3)
    expect(versions[1]!.version).toBe(2)
    expect(versions[2]!.version).toBe(1)
  })

  it('includes name, version, path, createdAt, size', () => {
    versioning.saveVersion('chart', 'hello world')
    const versions = versioning.listVersions('chart')
    expect(versions).toHaveLength(1)
    const v = versions[0]!
    expect(v.name).toBe('chart')
    expect(v.version).toBe(1)
    expect(v.path).toContain('v1.html')
    expect(v.createdAt).toBeTruthy()
    expect(v.size).toBe(11) // 'hello world'.length
  })
})

// ── getVersion ──

describe('getVersion', () => {
  it('returns null for non-existent artifact', () => {
    expect(versioning.getVersion('nonexistent')).toBeNull()
  })

  it('returns null for non-existent version', () => {
    versioning.saveVersion('chart', 'content')
    expect(versioning.getVersion('chart', 99)).toBeNull()
  })

  it('returns the latest version when no version number is given', () => {
    versioning.saveVersion('chart', 'first')
    versioning.saveVersion('chart', 'second')
    expect(versioning.getVersion('chart')).toBe('second')
  })

  it('returns a specific version by number', () => {
    versioning.saveVersion('chart', 'first')
    versioning.saveVersion('chart', 'second')
    versioning.saveVersion('chart', 'third')
    expect(versioning.getVersion('chart', 1)).toBe('first')
    expect(versioning.getVersion('chart', 2)).toBe('second')
    expect(versioning.getVersion('chart', 3)).toBe('third')
  })

  it('returns null when version 0 is requested', () => {
    versioning.saveVersion('chart', 'content')
    expect(versioning.getVersion('chart', 0)).toBeNull()
  })
})

// ── diff ──

describe('diff', () => {
  it('returns "(no changes)" for identical versions', () => {
    versioning.saveVersion('chart', 'line1\nline2')
    versioning.saveVersion('chart', 'line1\nline2')
    expect(versioning.diff('chart', 1, 2)).toBe('(no changes)')
  })

  it('shows added lines with + prefix', () => {
    versioning.saveVersion('chart', 'line1')
    versioning.saveVersion('chart', 'line1\nline2')
    const diff = versioning.diff('chart', 1, 2)
    expect(diff).toContain('+ line2')
  })

  it('shows removed lines with - prefix', () => {
    versioning.saveVersion('chart', 'line1\nline2')
    versioning.saveVersion('chart', 'line2')
    const diff = versioning.diff('chart', 1, 2)
    expect(diff).toContain('- line1')
  })

  it('shows both additions and removals', () => {
    versioning.saveVersion('chart', 'old line')
    versioning.saveVersion('chart', 'new line')
    const diff = versioning.diff('chart', 1, 2)
    expect(diff).toContain('- old line')
    expect(diff).toContain('+ new line')
  })

  it('handles multi-line changes', () => {
    versioning.saveVersion('chart', 'a\nb\nc')
    versioning.saveVersion('chart', 'a\nx\nc')
    const diff = versioning.diff('chart', 1, 2)
    expect(diff).toContain('- b')
    expect(diff).toContain('+ x')
    expect(diff).not.toContain('a')
    expect(diff).not.toContain('c')
  })

  it('returns empty string diff for non-existent versions', () => {
    versioning.saveVersion('chart', 'content')
    const diff = versioning.diff('chart', 99, 100)
    expect(diff).toBe('(no changes)')
  })

  it('handles version length mismatch (new version has more lines)', () => {
    versioning.saveVersion('chart', 'a')
    versioning.saveVersion('chart', 'a\nb\nc')
    const diff = versioning.diff('chart', 1, 2)
    expect(diff).toContain('+ b')
    expect(diff).toContain('+ c')
  })

  it('handles version length mismatch (old version has more lines)', () => {
    versioning.saveVersion('chart', 'a\nb\nc')
    versioning.saveVersion('chart', 'a')
    const diff = versioning.diff('chart', 1, 2)
    expect(diff).toContain('- b')
    expect(diff).toContain('- c')
  })
})
