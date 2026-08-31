/**
 * Marketplace sources — discover and install skills from any public GitHub
 * repository that follows the standard `SKILL.md` (frontmatter name/description)
 * convention. This lifts skill installation out of the hard-coded community
 * registry so users can add any public repo as a source.
 */
import { parse as parseYaml } from 'yaml'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { URL } from 'node:url'

export const MARKETPLACES_PATH = join(homedir(), '.mipham', 'marketplaces.json')

export interface SkillFrontmatter {
  name: string
  description: string
}

/**
 * Parse a `SKILL.md` document's frontmatter for `name`/`description`. Returns
 * null when there is no frontmatter, the YAML is invalid, or `name` is missing.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const src = content.replace(/^﻿/, '')
  const match = src.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  let data: Record<string, unknown>
  try {
    data = parseYaml(match[1] || '') as Record<string, unknown>
  } catch {
    return null
  }
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  if (!name) return null
  const description = typeof data.description === 'string' ? data.description : ''
  return { name, description }
}

export interface MarketplaceSource {
  owner: string
  repo: string
}

export const DEFAULT_MARKETPLACES: MarketplaceSource[] = [
  { owner: 'anthropics', repo: 'claude-plugins-community' },
  { owner: 'anthropics', repo: 'skills' },
]

/** owner/repo must be plain GitHub names (letters, digits, dot, dash, underscore). */
export function isValidMarketplaceRef(owner: string, repo: string): boolean {
  const valid = (s: string) => /^[a-zA-Z0-9._-]+$/.test(s) && s.length > 0
  return valid(owner) && valid(repo)
}

/**
 * Read the marketplace sources from disk. A missing or corrupt file falls back
 * to the default Anthropic sources.
 */
export function readMarketplaces(readFile: (path: string) => string | null): MarketplaceSource[] {
  const raw = readFile(MARKETPLACES_PATH)
  if (raw === null) return [...DEFAULT_MARKETPLACES]
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_MARKETPLACES]
    return parsed.filter(
      (s): s is MarketplaceSource =>
        !!s && typeof s === 'object' && typeof s.owner === 'string' && typeof s.repo === 'string',
    )
  } catch {
    return [...DEFAULT_MARKETPLACES]
  }
}

export function addMarketplace(
  current: MarketplaceSource[],
  owner: string,
  repo: string,
): { sources: MarketplaceSource[]; added: boolean } {
  if (current.some((s) => s.owner === owner && s.repo === repo)) {
    return { sources: current, added: false }
  }
  return { sources: [...current, { owner, repo }], added: true }
}

export function removeMarketplace(
  current: MarketplaceSource[],
  owner: string,
  repo: string,
): { sources: MarketplaceSource[]; removed: boolean } {
  const sources = current.filter((s) => !(s.owner === owner && s.repo === repo))
  return { sources, removed: sources.length !== current.length }
}

export interface DiscoveredSkill {
  name: string
  description: string
  path: string
}

/** Minimal fetch shape (ok/json/text) so discovery is testable without real network. */
export interface FetchLike {
  (url: string): Promise<{ ok: boolean; json: () => Promise<unknown>; text: () => Promise<string> }>
}

/**
 * List every `SKILL.md` blob path in a repository via the GitHub trees API.
 * Returns [] on any failure (network, rate-limit, non-2xx).
 */
export async function listSkillPaths(
  source: MarketplaceSource,
  fetchFn: FetchLike,
): Promise<string[]> {
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/HEAD?recursive=1`
  try {
    const res = await fetchFn(url)
    if (!res.ok) return []
    const data = (await res.json()) as { tree?: Array<{ path?: string; type?: string }> }
    return (data.tree ?? [])
      .filter((e) => e.type === 'blob' && e.path?.endsWith('SKILL.md'))
      .map((e) => e.path!)
  } catch {
    return []
  }
}

/**
 * Discover every skill in a repository: list `SKILL.md` paths, fetch each from
 * raw.githubusercontent.com, and parse its frontmatter for name/description.
 */
export async function discoverSkills(
  source: MarketplaceSource,
  fetchFn: FetchLike,
  download: (url: string) => Promise<string>,
): Promise<DiscoveredSkill[]> {
  const paths = await listSkillPaths(source, fetchFn)
  const skills = await Promise.all(
    paths.map(async (path) => {
      const rawUrl = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/HEAD/${path}`
      try {
        const fm = parseSkillFrontmatter(await download(rawUrl))
        return fm ? { name: fm.name, description: fm.description, path } : null
      } catch {
        return null
      }
    }),
  )
  return skills.filter((s): s is DiscoveredSkill => s !== null)
}

export interface FoundSkill {
  name: string
  description: string
  source: MarketplaceSource
  path: string
  rawUrl: string
}

/**
 * Search every marketplace source for a skill by name (first match wins, in
 * source order). Returns null when no source exposes it.
 */
export async function findSkillInMarketplaces(
  skillName: string,
  sources: MarketplaceSource[],
  fetchFn: FetchLike,
  download: (url: string) => Promise<string>,
): Promise<FoundSkill | null> {
  for (const source of sources) {
    const skills = await discoverSkills(source, fetchFn, download)
    const found = skills.find((s) => s.name === skillName)
    if (found) {
      return {
        name: found.name,
        description: found.description,
        source,
        path: found.path,
        rawUrl: `https://raw.githubusercontent.com/${source.owner}/${source.repo}/HEAD/${found.path}`,
      }
    }
  }
  return null
}

/** Allowed domains for remote skill installation. */
const ALLOWED_DOMAINS = [
  'raw.githubusercontent.com',
  'github.com',
  'gist.githubusercontent.com',
  'gitlab.com',
]

/**
 * Download a file over HTTPS via `curl` (spawn, no shell injection), restricted
 * to known-safe domains. Async so multiple downloads can run in parallel.
 */
export async function downloadFile(rawUrl: string): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs are allowed (got: ${parsed.protocol})`)
  }
  if (!ALLOWED_DOMAINS.some((d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
    throw new Error(
      `Domain not allowed: ${parsed.hostname}. Allowed: ${ALLOWED_DOMAINS.join(', ')}`,
    )
  }

  return new Promise<string>((resolve, reject) => {
    const proc = spawn('curl', ['-fsSL', rawUrl], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Download timed out: ${rawUrl}`))
    }, 15_000)
    proc.stdout.on('data', (c) => (stdout += c))
    proc.stderr.on('data', (c) => (stderr += c))
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`Failed to download: ${err.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`Download failed with status ${code}: ${stderr}`))
    })
  })
}
