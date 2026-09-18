import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { archiveVersion, readManifest, addToManifest } from '../../src/artifacts/manifest'
import type { ArtifactEntry } from '../../src/shared/types'

// ============================================================
// archiveVersion 的诚实边界 —— 只记「真的发生过的」那一版。
//
// 它原先在源文件找不到时静默跳过改名，却照样把 versions 推进一格、写进 manifest，
// 于是 manifest 里躺着一版磁盘上并不存在的版本。走到那条路并不难：条目按 name 找、
// 文件按 `<session>/<name><ext>` 找，把同一个名字从 html 改成 svg 就错开了。
// ============================================================

describe('archiveVersion', () => {
  let dir: string

  const entry = (over: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
    name: 'chart',
    path: join(dir, 'sess-1', 'chart.html'),
    url: 'http://localhost:9876/sess-1/chart.html',
    size: 10,
    type: 'html',
    createdAt: '2026-09-18T00:00:00.000Z',
    sessionId: 'sess-1',
    versionCount: 1,
    versions: ['v1'],
    ...over,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mipham-manifest-'))
    mkdirSync(join(dir, 'sess-1'), { recursive: true })
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, artifacts: [] }), 'utf-8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('源文件在：改名归档，并把这一版记进 manifest（正控）', () => {
    const e = entry()
    addToManifest(dir, e)
    writeFileSync(join(dir, 'sess-1', 'chart.html'), 'v1 content', 'utf-8')

    const tag = archiveVersion(dir, e)

    expect(tag).toBe('v2')
    expect(existsSync(join(dir, 'sess-1', 'chart.v2.html'))).toBe(true)
    expect(existsSync(join(dir, 'sess-1', 'chart.html'))).toBe(false)

    const after = readManifest(dir).artifacts[0]!
    expect(after.versions).toEqual(['v1', 'v2'])
    expect(after.versionCount).toBe(2)
  })

  it('源文件不在：不返回版本标签，也不往 manifest 里记一版假的', () => {
    // 名字对上了，类型变了 —— 条目说 .html，磁盘上只有 .svg。
    const e = entry()
    addToManifest(dir, e)
    writeFileSync(join(dir, 'sess-1', 'chart.svg'), '<svg/>', 'utf-8')

    const tag = archiveVersion(dir, e)

    expect(tag).toBeUndefined()
    const after = readManifest(dir).artifacts[0]!
    expect(after.versions).toEqual(['v1'])
    expect(after.versionCount).toBe(1)
  })
})
