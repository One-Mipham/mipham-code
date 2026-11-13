import { describe, it, expect, vi } from 'vitest'
import {
  parseSkillFrontmatter,
  isValidMarketplaceRef,
  isValidSkillName,
  readMarketplaces,
  addMarketplace,
  removeMarketplace,
  listSkillPaths,
  discoverSkills,
  findSkillInMarketplaces,
  DEFAULT_MARKETPLACES,
  MARKETPLACES_PATH,
} from '../../src/skills/marketplace'

describe('parseSkillFrontmatter', () => {
  it('extracts name and description from frontmatter', () => {
    const content = '---\nname: eli5\ndescription: Explain like 5\n---\n# body\n'
    expect(parseSkillFrontmatter(content)).toEqual({
      name: 'eli5',
      description: 'Explain like 5',
    })
  })

  it('returns null when name is missing', () => {
    const content = '---\ndescription: no name here\n---\n# body\n'
    expect(parseSkillFrontmatter(content)).toBeNull()
  })

  it('returns null when there is no frontmatter', () => {
    expect(parseSkillFrontmatter('# just a body\n')).toBeNull()
  })

  it('defaults description to empty string when absent', () => {
    const content = '---\nname: grill-me\n---\n# body\n'
    expect(parseSkillFrontmatter(content)).toEqual({ name: 'grill-me', description: '' })
  })
})

describe('isValidMarketplaceRef', () => {
  it('accepts plain owner/repo names', () => {
    expect(isValidMarketplaceRef('anthropics', 'claude-plugins-community')).toBe(true)
    expect(isValidMarketplaceRef('mattpocock', 'skills')).toBe(true)
  })

  it('rejects path traversal and special characters', () => {
    expect(isValidMarketplaceRef('anthropics', '../etc')).toBe(false)
    expect(isValidMarketplaceRef('a/b', 'skills')).toBe(false)
    expect(isValidMarketplaceRef('anthropics', 'repo with space')).toBe(false)
    expect(isValidMarketplaceRef('anthropics', 'repo@evil')).toBe(false)
  })
})

describe('isValidSkillName', () => {
  it('accepts kebab-case, dotted, and underscored names', () => {
    expect(isValidSkillName('eli5')).toBe(true)
    expect(isValidSkillName('grill-me')).toBe(true)
    expect(isValidSkillName('doc-sync')).toBe(true)
    expect(isValidSkillName('foo.bar')).toBe(true)
    expect(isValidSkillName('foo_bar')).toBe(true)
  })

  it('rejects path traversal and separators', () => {
    expect(isValidSkillName('../../evil')).toBe(false)
    expect(isValidSkillName('foo/bar')).toBe(false)
    expect(isValidSkillName('/etc/passwd')).toBe(false)
    expect(isValidSkillName('..')).toBe(false)
    expect(isValidSkillName('.')).toBe(false)
    expect(isValidSkillName('foo\\bar')).toBe(false)
  })

  it('rejects empty, leading-dot, and whitespace names', () => {
    expect(isValidSkillName('')).toBe(false)
    expect(isValidSkillName('.hidden')).toBe(false)
    expect(isValidSkillName('has space')).toBe(false)
    expect(isValidSkillName('tab\tname')).toBe(false)
  })
})

describe('readMarketplaces', () => {
  it('returns default sources when the file is missing', () => {
    expect(readMarketplaces(() => null)).toEqual(DEFAULT_MARKETPLACES)
  })

  it('returns default sources when the file is corrupt', () => {
    expect(readMarketplaces(() => 'not json')).toEqual(DEFAULT_MARKETPLACES)
  })

  it('parses a valid source list', () => {
    const raw = JSON.stringify([{ owner: 'mattpocock', repo: 'skills' }])
    expect(readMarketplaces(() => raw)).toEqual([{ owner: 'mattpocock', repo: 'skills' }])
  })

  // ── 295-004：回落可以，但不能是哑的（回落值会被下一次写落盘）──
  it('文件坏掉时通过 warn 报出，而不是默默换成默认源', () => {
    const warnings: string[] = []
    expect(
      readMarketplaces(
        () => 'not json',
        (m) => warnings.push(m),
      ),
    ).toEqual(DEFAULT_MARKETPLACES)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(MARKETPLACES_PATH)
  })

  it('形状不对（合法 JSON 但非数组）也报', () => {
    const warnings: string[] = []
    readMarketplaces(
      () => '{"owner":"x"}',
      (m) => warnings.push(m),
    )
    expect(warnings).toHaveLength(1)
  })

  it('（对照）文件缺失是常态，不报', () => {
    const warnings: string[] = []
    readMarketplaces(
      () => null,
      (m) => warnings.push(m),
    )
    expect(warnings).toEqual([])
  })

  it('（对照）合法列表不报', () => {
    const warnings: string[] = []
    readMarketplaces(
      () => JSON.stringify([{ owner: 'a', repo: 'b' }]),
      (m) => warnings.push(m),
    )
    expect(warnings).toEqual([])
  })
})

describe('addMarketplace', () => {
  it('adds a new source', () => {
    const current = [...DEFAULT_MARKETPLACES]
    const r = addMarketplace(current, 'mattpocock', 'skills')
    expect(r.added).toBe(true)
    expect(r.sources).toHaveLength(DEFAULT_MARKETPLACES.length + 1)
  })

  it('does not duplicate an existing source', () => {
    const current = [...DEFAULT_MARKETPLACES]
    const r = addMarketplace(current, DEFAULT_MARKETPLACES[0]!.owner, DEFAULT_MARKETPLACES[0]!.repo)
    expect(r.added).toBe(false)
    expect(r.sources).toHaveLength(DEFAULT_MARKETPLACES.length)
  })
})

describe('removeMarketplace', () => {
  it('removes an existing source', () => {
    const current = [...DEFAULT_MARKETPLACES]
    const r = removeMarketplace(
      current,
      DEFAULT_MARKETPLACES[0]!.owner,
      DEFAULT_MARKETPLACES[0]!.repo,
    )
    expect(r.removed).toBe(true)
    expect(r.sources).toHaveLength(DEFAULT_MARKETPLACES.length - 1)
  })

  it('reports no removal when the source is absent', () => {
    const current = [...DEFAULT_MARKETPLACES]
    const r = removeMarketplace(current, 'nobody', 'nothing')
    expect(r.removed).toBe(false)
    expect(r.sources).toHaveLength(DEFAULT_MARKETPLACES.length)
  })
})

function okResponse(body: unknown): {
  ok: boolean
  json: () => Promise<unknown>
  text: () => Promise<string>
} {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(text) }
}

describe('listSkillPaths', () => {
  it('lists blob SKILL.md paths from the git tree', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({
        tree: [
          { path: 'eli5/skills/eli5/SKILL.md', type: 'blob' },
          { path: 'README.md', type: 'blob' },
          { path: 'skills', type: 'tree' },
          { path: 'grill-me/SKILL.md', type: 'blob' },
        ],
      }),
    )
    const paths = await listSkillPaths({ owner: 'anthropics', repo: 'skills' }, fetchFn)
    expect(paths).toEqual(['eli5/skills/eli5/SKILL.md', 'grill-me/SKILL.md'])
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.github.com/repos/anthropics/skills/git/trees/HEAD?recursive=1',
    )
  })

  it('API 失败时抛错，不返回空数组 —— 「没搜到」与「没搜成」必须分开', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve(null) })
    await expect(listSkillPaths({ owner: 'a', repo: 'b' }, fetchFn)).rejects.toThrow(
      /GitHub API 403 for a\/b/,
    )
  })

  it('网络异常同样抛出（不被吞成「这个仓库没有技能」）', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    await expect(listSkillPaths({ owner: 'a', repo: 'b' }, fetchFn)).rejects.toThrow(/ENOTFOUND/)
  })

  it('真的没有 SKILL.md 时仍然返回空数组', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okResponse({ tree: [{ path: 'README.md', type: 'blob' }] }))
    expect(await listSkillPaths({ owner: 'a', repo: 'b' }, fetchFn)).toEqual([])
  })
})

describe('discoverSkills', () => {
  it('discovers name and description from each SKILL.md', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okResponse({ tree: [{ path: 'eli5/SKILL.md', type: 'blob' }] }))
    const download = vi.fn().mockResolvedValue('---\nname: eli5\ndescription: Explain\n---\nbody')
    const skills = await discoverSkills({ owner: 'anthropics', repo: 'skills' }, fetchFn, download)
    expect(skills).toEqual([{ name: 'eli5', description: 'Explain', path: 'eli5/SKILL.md' }])
  })

  it('skips skill files without a valid name', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okResponse({ tree: [{ path: 'bad/SKILL.md', type: 'blob' }] }))
    const download = vi.fn().mockResolvedValue('---\ndescription: no name\n---\nbody')
    expect(await discoverSkills({ owner: 'a', repo: 'b' }, fetchFn, download)).toEqual([])
  })
})

describe('findSkillInMarketplaces', () => {
  it('finds a skill by name across sources', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okResponse({ tree: [{ path: 'eli5/SKILL.md', type: 'blob' }] }))
    const download = vi.fn().mockResolvedValue('---\nname: eli5\ndescription: Explain\n---\nbody')
    const found = await findSkillInMarketplaces(
      'eli5',
      [{ owner: 'anthropics', repo: 'skills' }],
      fetchFn,
      download,
    )
    expect(found).not.toBeNull()
    expect(found!.name).toBe('eli5')
    expect(found!.rawUrl).toBe(
      'https://raw.githubusercontent.com/anthropics/skills/HEAD/eli5/SKILL.md',
    )
  })

  it('returns null when the skill is not in any source', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ tree: [] }))
    const download = vi.fn().mockResolvedValue('')
    expect(
      await findSkillInMarketplaces('nope', [{ owner: 'a', repo: 'b' }], fetchFn, download),
    ).toBeNull()
  })

  it('某个源搜不成、而技能又没在能搜的源里找到 ⇒ 抛错，不报「不存在」', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve(null) })
    const download = vi.fn().mockResolvedValue('')
    await expect(
      findSkillInMarketplaces('eli5', [{ owner: 'a', repo: 'b' }], fetchFn, download),
    ).rejects.toThrow(/could not search 1 of 1 marketplace source\(s\).*a\/b: GitHub API 503/)
  })

  it('前面的源失败、后面的源有这个技能 ⇒ 仍然返回它（找得到就是找得到）', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve(null) })
      .mockResolvedValueOnce(okResponse({ tree: [{ path: 'eli5/SKILL.md', type: 'blob' }] }))
    const download = vi.fn().mockResolvedValue('---\nname: eli5\ndescription: Explain\n---\nbody')
    const found = await findSkillInMarketplaces(
      'eli5',
      [
        { owner: 'a', repo: 'b' },
        { owner: 'anthropics', repo: 'skills' },
      ],
      fetchFn,
      download,
    )
    expect(found?.name).toBe('eli5')
    expect(found?.source).toEqual({ owner: 'anthropics', repo: 'skills' })
  })
})
