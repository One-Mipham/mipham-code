import { describe, it, expect, vi } from 'vitest'
import {
  parseSkillFrontmatter,
  isValidMarketplaceRef,
  readMarketplaces,
  addMarketplace,
  removeMarketplace,
  listSkillPaths,
  discoverSkills,
  findSkillInMarketplaces,
  DEFAULT_MARKETPLACES,
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

  it('returns empty on API failure', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve(null) })
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
})
