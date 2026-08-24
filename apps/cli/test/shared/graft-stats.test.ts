import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readGraftStats } from '../../src/shared/graft-stats'

describe('readGraftStats', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graft-stats-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeStats(json: string): void {
    const cacheDir = join(dir, 'graft', '.cache')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'stats.json'), json)
  }

  it('returns null when graft is not built (no stats.json)', () => {
    expect(readGraftStats(dir)).toBeNull()
  })

  it('reads node/edge/stale counts and freshness flags', () => {
    writeStats(
      JSON.stringify({
        nodeCount: 2907,
        edgeCount: 6634,
        staleCount: 9,
        dirty: true,
        syncing: false,
      }),
    )
    expect(readGraftStats(dir)).toEqual({
      nodeCount: 2907,
      edgeCount: 6634,
      staleCount: 9,
      dirty: true,
      syncing: false,
    })
  })

  it('returns null when the graph is empty (nodeCount 0)', () => {
    writeStats(JSON.stringify({ nodeCount: 0, edgeCount: 0 }))
    expect(readGraftStats(dir)).toBeNull()
  })

  it('returns null on malformed JSON', () => {
    writeStats('not json')
    expect(readGraftStats(dir)).toBeNull()
  })
})
