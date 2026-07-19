/**
 * Mipham Code — Skill Registry & Installer
 *
 * Provides a community skill marketplace: browse, search, and install skills
 * from remote sources (GitHub repos, direct URLs).
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { URL } from 'node:url'

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
}

/**
 * Embedded community skill registry.
 * In the future, this can be fetched from a remote URL.
 */
const COMMUNITY_SKILLS: SkillEntry[] = [
  {
    name: 'code-review',
    description: 'Automated code review with multiple dimensions',
    url: 'https://github.com/One-Mipham/skill-code-review',
    file: 'code-review.SKILL.md',
    category: 'Development',
    author: 'MiphamAI',
  },
  {
    name: 'systematic-debugging',
    description: 'Systematic debugging workflow — find root cause before fixing',
    url: 'https://github.com/anthropics/skills',
    file: 'systematic-debugging.SKILL.md',
    category: 'Development',
    author: 'Anthropic',
  },
  {
    name: 'test-driven-development',
    description: 'TDD workflow — write failing test first, then implement',
    url: 'https://github.com/anthropics/skills',
    file: 'test-driven-development.SKILL.md',
    category: 'Development',
    author: 'Anthropic',
  },
  {
    name: 'web-access',
    description: 'Web search, scraping, and browser automation',
    url: 'https://github.com/One-Mipham/skill-web-access',
    file: 'web-access.SKILL.md',
    category: 'Network',
    author: 'MiphamAI',
  },
  {
    name: 'doc-generator',
    description: 'Generate API docs, READMEs, and changelogs',
    url: 'https://github.com/One-Mipham/skill-doc-generator',
    file: 'doc-generator.SKILL.md',
    category: 'Documentation',
    author: 'MiphamAI',
  },
  {
    name: 'github-ops',
    description: 'GitHub PR/issue management and automation',
    url: 'https://github.com/One-Mipham/skill-github-ops',
    file: 'github-ops.SKILL.md',
    category: 'DevOps',
    author: 'MiphamAI',
  },
  {
    name: 'security-review',
    description: 'Security audit and vulnerability scanning for code changes',
    url: 'https://github.com/One-Mipham/skill-security-review',
    file: 'security-review.SKILL.md',
    category: 'Security',
    author: 'MiphamAI',
  },
  {
    name: 'frontend-design',
    description: 'Distinctive visual design guidance for UI components',
    url: 'https://github.com/anthropics/skills',
    file: 'frontend-design.SKILL.md',
    category: 'Design',
    author: 'Anthropic',
  },
]

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
 * Install a skill from a GitHub repository.
 *
 * Clones the repo to a temp directory, copies the skill file(s),
 * and cleans up.
 */
export function installSkill(skillName: string): InstallResult {
  const entry = COMMUNITY_SKILLS.find((s) => s.name === skillName)
  if (!entry) {
    return {
      success: false,
      name: skillName,
      message: `Skill "${skillName}" not found in the registry. Use /browse-skills to see available skills.`,
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
    const content = downloadFile(rawUrl)

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
 * Install a skill from a direct URL (GitHub raw, gist, or any HTTP URL).
 */
export function installSkillFromUrl(url: string): InstallResult {
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
    const content = downloadFile(url)

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

/** Allowed domains for remote skill installation */
const ALLOWED_DOMAINS = [
  'raw.githubusercontent.com',
  'github.com',
  'gist.githubusercontent.com',
  'gitlab.com',
]

/**
 * Download a file from a URL using curl with spawn (no shell injection).
 * Only allows HTTPS URLs from known safe domains.
 */
function downloadFile(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`)
  }

  // Protocol must be HTTPS
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs are allowed (got: ${parsed.protocol})`)
  }

  // Domain must be in allowlist
  if (!ALLOWED_DOMAINS.some((d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
    throw new Error(
      `Domain not allowed: ${parsed.hostname}. Allowed: ${ALLOWED_DOMAINS.join(', ')}`,
    )
  }

  // Use spawnSync with args array — no shell, no injection
  const result = spawnSync('curl', ['-fsSL', rawUrl], {
    encoding: 'utf-8',
    timeout: 15_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (result.error) {
    throw new Error(`Failed to download: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`Download failed with status ${result.status}`)
  }

  return result.stdout
}
