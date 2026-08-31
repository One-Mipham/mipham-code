/**
 * Mipham Code — Skill Registry & Installer
 *
 * Provides a community skill marketplace: browse, search, and install skills
 * from remote sources (GitHub repos, direct URLs).
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { MiphamConfig } from '../shared/types.js'
import communitySkills from './community-registry.json'
import { readMarketplaces, findSkillInMarketplaces, downloadFile } from './marketplace'

const SKILLS_DIR = join(homedir(), '.mipham', 'skills')

// ═══════════════════════════════════════════════════════════════
// Community Skill Registry
// ═══════════════════════════════════════════════════════════════

export interface SkillEntry {
  /** Unique skill name (kebab-case) */
  name: string
  /** One-line description */
  description: string
  /** GitHub repo URL (https://github.com/owner/repo) */
  url: string
  /** Skill file path within the repo (e.g. "skill.SKILL.md") */
  file?: string
  /** Category for grouping */
  category: string
  /** Author */
  author: string
  /** If true, skill is already built-in — no download needed */
  builtin?: boolean
}

/**
 * Embedded community skill registry.
 * In the future, this can be fetched from a remote URL.
 */
const COMMUNITY_SKILLS: SkillEntry[] = communitySkills as SkillEntry[]

// ═══════════════════════════════════════════════════════════════
// Skill Installer
// ═══════════════════════════════════════════════════════════════

export interface InstallResult {
  success: boolean
  name: string
  message: string
}

/**
 * Get the list of available community skills.
 */
export function getAvailableSkills(): SkillEntry[] {
  return [...COMMUNITY_SKILLS]
}

/**
 * Search for skills by name or description.
 */
export function searchSkills(query: string): SkillEntry[] {
  const q = query.toLowerCase()
  return COMMUNITY_SKILLS.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  )
}

/**
 * Match a marketplace pattern against an owner/repo.
 *
 * - "owner/*"  → matches any repo under that owner
 * - "owner/repo" → exact match
 */
function matchOwnerPattern(pattern: string, owner: string, repo: string): boolean {
  if (pattern.endsWith('/*')) {
    return pattern.slice(0, -2) === owner
  }
  return pattern === repo
}

/**
 * Check whether a GitHub URL (or any URL) is allowed by the marketplace config.
 *
 * Rules (in order):
 * 1. No config → allow everything
 * 2. blockedMarketplaces matched → deny (deny wins over allow)
 * 3. strictKnownMarketplaces set → deny unless matched
 * 4. Non-GitHub URL with no strict list → allow
 * 5. Non-GitHub URL with strict list → deny
 */
function isMarketplaceAllowed(url: string, config?: MiphamConfig['marketplace']): boolean {
  if (!config) return true
  const { strictKnownMarketplaces, blockedMarketplaces } = config
  const match = url.match(/github\.com\/([^/]+\/[^/]+)/)
  if (!match) return !strictKnownMarketplaces?.length // non-GitHub: allow only if no strict list
  const repo = match[1]! // "owner/repo"
  const [owner] = repo.split('/')

  // Check blocked first (deny wins)
  if (blockedMarketplaces?.some((pattern) => matchOwnerPattern(pattern, owner!, repo))) return false
  // Check strict allowlist
  if (
    strictKnownMarketplaces?.length &&
    !strictKnownMarketplaces.some((pattern) => matchOwnerPattern(pattern, owner!, repo))
  )
    return false
  return true
}

/**
 * Install a skill from a GitHub repository.
 *
 * Clones the repo to a temp directory, copies the skill file(s),
 * and cleans up.
 */
export async function installSkill(
  skillName: string,
  marketplaceConfig?: MiphamConfig['marketplace'],
): Promise<InstallResult> {
  const entry = COMMUNITY_SKILLS.find((s) => s.name === skillName)
  if (!entry) {
    return installFromMarketplace(skillName, marketplaceConfig)
  }

  // Check marketplace restrictions
  if (!isMarketplaceAllowed(entry.url, marketplaceConfig)) {
    return {
      success: false,
      name: skillName,
      message: `Skill "${skillName}" is from a blocked or unapproved marketplace: ${entry.url}`,
    }
  }

  // Built-in skills are already available — no download needed
  if (entry.builtin) {
    return {
      success: true,
      name: skillName,
      message: `Skill "${skillName}" is already built-in and ready to use. No installation needed.`,
    }
  }

  const destDir = join(SKILLS_DIR)
  const destPath = join(destDir, `${skillName}.SKILL.md`)

  // Check if already installed
  if (existsSync(destPath)) {
    return {
      success: false,
      name: skillName,
      message: `Skill "${skillName}" is already installed. Remove it first to reinstall.`,
    }
  }

  mkdirSync(destDir, { recursive: true })

  try {
    // Download the skill file from GitHub raw content
    const rawUrl = githubRawUrl(entry.url, entry.file || `${skillName}.SKILL.md`)
    const content = await downloadFile(rawUrl)

    // Validate it's a proper skill file (has frontmatter)
    if (!content.includes('---')) {
      return {
        success: false,
        name: skillName,
        message: `Downloaded file does not appear to be a valid skill (missing frontmatter).`,
      }
    }

    writeFileSync(destPath, content, 'utf-8')

    return {
      success: true,
      name: skillName,
      message: `Skill "${skillName}" installed to ${destPath}\nRun /reload-skills to activate it.`,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      name: skillName,
      message: `Failed to install "${skillName}": ${msg}`,
    }
  }
}

/**
 * Install a skill by discovering it across the user's marketplace sources.
 * Called when the name is not in the built-in community registry.
 */
async function installFromMarketplace(
  skillName: string,
  marketplaceConfig?: MiphamConfig['marketplace'],
): Promise<InstallResult> {
  const sources = readMarketplaces((p) => (existsSync(p) ? readFileSync(p, 'utf-8') : null))
  const found = await findSkillInMarketplaces(skillName, sources, globalThis.fetch, downloadFile)

  if (!found) {
    return {
      success: false,
      name: skillName,
      message: `Skill "${skillName}" not found in the registry or any marketplace. Use /browse-skills or /browse-marketplace.`,
    }
  }
  if (!isMarketplaceAllowed(found.rawUrl, marketplaceConfig)) {
    return {
      success: false,
      name: skillName,
      message: `Skill "${skillName}" is from a blocked or unapproved marketplace: ${found.rawUrl}`,
    }
  }

  const destPath = join(SKILLS_DIR, `${found.name}.SKILL.md`)
  if (existsSync(destPath)) {
    return {
      success: false,
      name: found.name,
      message: `Skill "${found.name}" is already installed. Remove it first to reinstall.`,
    }
  }

  mkdirSync(SKILLS_DIR, { recursive: true })
  try {
    const content = await downloadFile(found.rawUrl)
    if (!content.includes('---')) {
      return {
        success: false,
        name: found.name,
        message: `Downloaded file does not appear to be a valid skill (missing frontmatter).`,
      }
    }
    writeFileSync(destPath, content, 'utf-8')
    return {
      success: true,
      name: found.name,
      message: `Skill "${found.name}" installed from ${found.source.owner}/${found.source.repo} to ${destPath}\nRun /reload-skills to activate it.`,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      name: found.name,
      message: `Failed to install "${found.name}": ${msg}`,
    }
  }
}

/**
 * Install a skill from a direct URL (GitHub raw, gist, or any HTTP URL).
 */
export async function installSkillFromUrl(
  url: string,
  marketplaceConfig?: MiphamConfig['marketplace'],
): Promise<InstallResult> {
  // Check marketplace restrictions
  if (!isMarketplaceAllowed(url, marketplaceConfig)) {
    return {
      success: false,
      name: url,
      message: `URL is from a blocked or unapproved marketplace: ${url}`,
    }
  }

  // Derive skill name from URL
  const name =
    url
      .split('/')
      .pop()
      ?.replace(/\.(SKILL\.)?md$/i, '') || 'custom-skill'

  const destDir = join(SKILLS_DIR)
  const destPath = join(destDir, `${name}.SKILL.md`)

  mkdirSync(destDir, { recursive: true })

  try {
    const content = await downloadFile(url)

    if (!content.includes('---')) {
      return {
        success: false,
        name,
        message: `Downloaded file does not appear to be a valid skill (missing frontmatter).`,
      }
    }

    writeFileSync(destPath, content, 'utf-8')

    return {
      success: true,
      name,
      message: `Skill "${name}" installed from URL to ${destPath}\nRun /reload-skills to activate it.`,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, name, message: `Failed to install from URL: ${msg}` }
  }
}

/**
 * List installed skills (files in ~/.mipham/skills/).
 */
export function listInstalledSkills(): string[] {
  if (!existsSync(SKILLS_DIR)) return []
  return readdirSync(SKILLS_DIR).filter(
    (f: string) => f.endsWith('.SKILL.md') || f.endsWith('.mipham-skill.md'),
  )
}

/**
 * Remove an installed skill.
 */
export function removeSkill(skillName: string): InstallResult {
  const destPath = join(SKILLS_DIR, `${skillName}.SKILL.md`)
  if (!existsSync(destPath)) {
    return { success: false, name: skillName, message: `Skill "${skillName}" is not installed.` }
  }
  try {
    unlinkSync(destPath)
    return {
      success: true,
      name: skillName,
      message: `Skill "${skillName}" removed. Run /reload-skills to refresh.`,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, name: skillName, message: `Failed to remove: ${msg}` }
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Convert a GitHub repo URL to a raw content URL.
 *   https://github.com/owner/repo → https://raw.githubusercontent.com/owner/repo/main/<file>
 */
function githubRawUrl(repoUrl: string, file: string): string {
  const base = repoUrl.replace('https://github.com/', 'https://raw.githubusercontent.com/')
  return `${base}/main/${file}`
}
