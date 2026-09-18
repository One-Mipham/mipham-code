import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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

  it('归档的是本会话那一条 —— 另一会话的同名条目不动', () => {
    // 条目按 name 找的话，这里会去推进 sess-2 那条的 versions。
    addToManifest(dir, entry())
    addToManifest(dir, entry({ sessionId: 'sess-2', versions: ['v1'], versionCount: 1 }))
    writeFileSync(join(dir, 'sess-1', 'chart.html'), 'v1 content', 'utf-8')

    expect(archiveVersion(dir, entry())).toBe('v2')

    const byId = Object.fromEntries(readManifest(dir).artifacts.map((a) => [a.sessionId, a]))
    expect(byId['sess-1']!.versions).toEqual(['v1', 'v2'])
    expect(byId['sess-2']!.versions).toEqual(['v1'])
    expect(byId['sess-2']!.versionCount).toBe(1)
  })
})

// ============================================================
// manifest 是**全局一份** index.json，条目自带 sessionId。
//
// 两条同源缺陷：去重只按 name（两个会话各发一个同名 artifact，后者顶掉前者，前者的
// 文件还在磁盘上却从索引里消失）；读取失败静默返回空 manifest 而写入紧接着整份重写
// （一份损坏的 index.json 被下一次发布覆盖成「只有这一条」，其余索引全丢）。
// ============================================================

describe('addToManifest', () => {
  let dir: string

  const entry = (over: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
    name: 'chart',
    path: join(dir, 'sess-1', 'chart.html'),
    url: 'http://localhost:9876/sess-1/chart.html',
    size: 10,
    type: 'html',
    createdAt: '2026-09-18T00:00:00.000Z',
    sessionId: 'sess-1',
    ...over,
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mipham-manifest-'))
    mkdirSync(dir, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('两个会话的同名 artifact 各留一条（正控：同会话内仍替换）', () => {
    addToManifest(dir, entry({ url: 'http://localhost:9876/sess-1/chart.html' }))
    addToManifest(
      dir,
      entry({ sessionId: 'sess-2', url: 'http://localhost:9876/sess-2/chart.html' }),
    )

    expect(readManifest(dir).artifacts).toHaveLength(2)

    addToManifest(dir, entry({ url: 'http://localhost:9876/sess-1/chart.v2.html' }))

    const artifacts = readManifest(dir).artifacts
    expect(artifacts).toHaveLength(2) // 同会话内是更新，不是新增
    expect(artifacts.find((a) => a.sessionId === 'sess-1')!.url).toContain('chart.v2.html')
  })

  it('index.json 读不出来时，不把索引重写成「只有这一条」', () => {
    addToManifest(dir, entry({ name: 'keep-me', sessionId: 'sess-old' }))
    const before = readFileSync(join(dir, 'index.json'), 'utf-8')

    // 半截 JSON —— 原子写之前，崩在写中途就是这个形态。
    writeFileSync(join(dir, 'index.json'), before.slice(0, 20), 'utf-8')

    const { manifest, quarantined } = addToManifest(dir, entry({ name: 'new-one' }))

    expect(quarantined).toBeTruthy()
    expect(manifest.artifacts.map((a) => a.name)).toEqual(['new-one'])
    // 旧索引的字节还在，只是换了名字 —— 丢了就真找不回来。
    expect(readFileSync(quarantined!, 'utf-8')).toBe(before.slice(0, 20))
  })

  it('index.json 不存在（首次发布）：不产生隔离文件', () => {
    const { quarantined } = addToManifest(dir, entry())

    expect(quarantined).toBeUndefined()
    expect(readManifest(dir).artifacts).toHaveLength(1)
  })
})
