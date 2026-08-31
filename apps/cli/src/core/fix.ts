/**
 * `/fix` — deterministic self-repair (no LLM). Orchestrates three repair targets:
 *   - doctor: write derivable CLAUDE.md sections into `prompt-exclude` frontmatter
 *   - config: restore a corrupted config.yml from backup, re-enable disabled hooks
 *   - cache:  detect corrupt JSONL state lines under ~/.mipham (dry-run by default)
 *
 * The pure decision functions live here for testability; file I/O and engine calls
 * are injected so each target is testable without touching the real filesystem.
 */
import { findDerivableSections } from './claude-md-audit'
import { applyPromptExclude } from './claude-md-fix'

export interface DoctorFix {
  content: string
  added: string[]
}

/**
 * Compute the repaired content for one CLAUDE.md document, or null when there is
 * nothing to change (no derivable sections, or all of them already excluded).
 */
export function computeDoctorFix(content: string): DoctorFix | null {
  const sections = findDerivableSections(content)
  if (sections.length === 0) return null
  const { content: fixed, added } = applyPromptExclude(
    content,
    sections.map((s) => s.heading),
  )
  return added.length > 0 ? { content: fixed, added } : null
}

/**
 * Return the 0-based line numbers of a JSONL document whose non-blank lines are not
 * valid JSON. Blank/whitespace-only lines are ignored.
 */
export function findCorruptJsonlLines(content: string): number[] {
  const corrupt: number[] = []
  content.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed === '') return
    try {
      JSON.parse(trimmed)
    } catch {
      corrupt.push(i)
    }
  })
  return corrupt
}

/** Drop the given line numbers from a document, keeping everything else verbatim. */
export function removeCorruptLines(content: string, corrupt: number[]): string {
  const corruptSet = new Set(corrupt)
  return content
    .split('\n')
    .filter((_, i) => !corruptSet.has(i))
    .join('\n')
}

/**
 * Select the CLAUDE.md files that live inside the current repository (project and
 * directory levels), excluding group/company/user policy files outside the repo.
 */
export function selectRepoClaudeFiles(
  files: Array<{ path: string; level: string }>,
): Array<{ path: string }> {
  return files
    .filter(
      (f) => f.path.endsWith('CLAUDE.md') && (f.level === 'project' || f.level === 'directory'),
    )
    .map((f) => ({ path: f.path }))
}

export interface DoctorReport {
  fixed: Array<{ path: string; added: string[] }>
}

/** Read each CLAUDE.md, apply the derivable-section fix, and write it back. */
export function fixDoctor(
  files: Array<{ path: string }>,
  io: { read: (path: string) => string | null; write: (path: string, content: string) => void },
): DoctorReport {
  const fixed: DoctorReport['fixed'] = []
  for (const f of files) {
    const raw = io.read(f.path)
    if (raw === null) continue
    const result = computeDoctorFix(raw)
    if (result) {
      io.write(f.path, result.content)
      fixed.push({ path: f.path, added: result.added })
    }
  }
  return { fixed }
}

export interface ConfigFixReport {
  /** Config files whose YAML failed to parse (detected). */
  corruptConfigs: string[]
  /** Corrupt config files actually restored from backup. */
  restoredConfigs: string[]
  /** Hooks currently disabled (detected). */
  disabledHooks: string[]
  /** Disabled hooks actually re-enabled. */
  reenabledHooks: string[]
}

/**
 * Detect corrupt config.yml files and disabled hooks. Repairs (restore from
 * backup / re-enable) only happen when `dryRun` is false; in dry-run the report
 * still lists what was detected without mutating anything.
 */
export function fixConfig(deps: {
  configPaths: string[]
  read: (path: string) => string | null
  parseYaml: (raw: string) => unknown
  restore: (path: string) => boolean
  hookHealth: () => Array<{ key: string; disabled: boolean }>
  reEnableHook: (key: string) => boolean
  dryRun?: boolean
}): ConfigFixReport {
  const report: ConfigFixReport = {
    corruptConfigs: [],
    restoredConfigs: [],
    disabledHooks: [],
    reenabledHooks: [],
  }

  for (const p of deps.configPaths) {
    const raw = deps.read(p)
    if (raw === null) continue
    let corrupt = false
    try {
      deps.parseYaml(raw)
    } catch {
      corrupt = true
    }
    if (!corrupt) continue
    report.corruptConfigs.push(p)
    if (!deps.dryRun && deps.restore(p)) report.restoredConfigs.push(p)
  }

  for (const h of deps.hookHealth()) {
    if (!h.disabled) continue
    report.disabledHooks.push(h.key)
    if (!deps.dryRun && deps.reEnableHook(h.key)) report.reenabledHooks.push(h.key)
  }
  return report
}

export interface CacheFixReport {
  files: Array<{ path: string; corruptLines: number[] }>
  cleaned: Array<{ path: string; removed: number }>
}

/**
 * Scan JSONL state files for corrupt lines. Reports them always; only rewrites the
 * file (dropping corrupt lines) when `apply` is true.
 */
export function fixCache(
  files: string[],
  io: { read: (path: string) => string | null; write: (path: string, content: string) => void },
  apply: boolean,
): CacheFixReport {
  const report: CacheFixReport = { files: [], cleaned: [] }
  for (const path of files) {
    const raw = io.read(path)
    if (raw === null) continue
    const corrupt = findCorruptJsonlLines(raw)
    if (corrupt.length === 0) continue
    report.files.push({ path, corruptLines: corrupt })
    if (apply) {
      io.write(path, removeCorruptLines(raw, corrupt))
      report.cleaned.push({ path, removed: corrupt.length })
    }
  }
  return report
}
