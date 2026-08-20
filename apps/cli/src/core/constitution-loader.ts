/**
 * Mipham Constitution — Machine-readable ethical & safety principles.
 *
 * Inspired by Anthropic's Constitutional AI: a human-auditable, version-controlled
 * set of principles that are injected into the agent's decision-making at every
 * critical juncture (tool execution, memory write, model inference).
 *
 * Unlike Anthropic's training-time constitution, Mipham's constitution is enforced
 * at runtime by the PreFlightChecker and SIS defense lines — making it auditable
 * on every single action, not just during training.
 *
 * Default location: ~/.mipham/ai-guardrails.yml
 * Format: YAML with schema validation
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import alignmentVocabulary from './alignment-vocabulary.json' with { type: 'json' }

// ── Types ──

export interface ConstitutionalPrinciple {
  /** Unique identifier for cross-referencing (e.g. "never-fabricate") */
  id: string
  /** Human-readable principle text */
  text: string
  /** Enforcement level */
  enforce: 'block' | 'warn' | 'auto'
  /** Optional: regex pattern for automated audit */
  audit_pattern?: string
  /** Optional: scope restriction */
  scope?: string
  /** Optional: which hook to attach to */
  hook?: 'pre-tool-use' | 'post-tool-use' | 'pre-inference' | 'post-turn'
  /** Optional: tool names this principle specifically applies to */
  tools?: string[]
  /** Optional: human explanation of why this principle exists */
  rationale?: string
  /** Optional: which alignment value (karuna/prajna/vajra) this principle operationalizes. */
  facet?: string
}

export interface MiphamConstitution {
  /** Semantic version for constitution changes */
  version: string
  /** Last modification date */
  last_modified: string
  /** The principles themselves */
  principles: ConstitutionalPrinciple[]
  /** 序言（愿力）：从对齐词汇表 values 派生的正向誓愿（悲/智/金刚），非禁令。 */
  preamble?: string
}

// ── Default Constitution (derived from the shared alignment vocabulary) ──

/** 从对齐词汇表的三个价值面派生「愿力」序言——正向誓愿，而非禁令。 */
function derivePreamble(): string {
  const parts = alignmentVocabulary.values
    .map((v) => `以${v.name_zh}（${v.name_en}）——${v.definition}`)
    .join('；')
  return `愿力（序言）：${parts}。愿不生成违规之倾向，而非仅避免违规之行为。`
}

export const DEFAULT_CONSTITUTION: MiphamConstitution = {
  version: alignmentVocabulary.version,
  last_modified: '2026-08-16',
  principles: alignmentVocabulary.principles as unknown as ConstitutionalPrinciple[],
  preamble: derivePreamble(),
}

// ── Loader ──

export class ConstitutionLoader {
  private path: string
  private cached: MiphamConstitution | null = null

  constructor(customPath?: string) {
    this.path = customPath || join(homedir(), '.mipham', 'ai-guardrails.yml')
  }

  /**
   * Load the constitution from disk.
   * Falls back to the built-in DEFAULT_CONSTITUTION if no file exists.
   */
  load(): MiphamConstitution {
    if (this.cached) return this.cached

    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, 'utf-8')
        const parsed = this.parseYaml(raw)
        if (this.validate(parsed)) {
          this.cached = parsed
          return parsed
        }
      }
    } catch {
      // Fall through to default
    }

    // Write the default constitution to disk for visibility
    this.cached = DEFAULT_CONSTITUTION
    try {
      const dir = join(homedir(), '.mipham')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.path, this.serializeToYaml(DEFAULT_CONSTITUTION), 'utf-8')
    } catch {
      // Best-effort — default constitution works in-memory
    }
    return this.cached
  }

  /** Reload from disk, bypassing cache. */
  reload(): MiphamConstitution {
    this.cached = null
    return this.load()
  }

  /** Get principles applicable to a specific tool. */
  getPrinciplesForTool(toolName: string): ConstitutionalPrinciple[] {
    const constitution = this.load()
    return constitution.principles.filter((p) => {
      if (p.scope === 'all-tools') return true
      if (p.tools && p.tools.includes(toolName)) return true
      return false
    })
  }

  /** Get principles for a specific hook phase. */
  getPrinciplesForHook(hook: ConstitutionalPrinciple['hook']): ConstitutionalPrinciple[] {
    const constitution = this.load()
    return constitution.principles.filter((p) => p.hook === hook)
  }

  /** Check if a given content string violates any audit patterns. */
  audit(content: string): Array<{ principle: ConstitutionalPrinciple; match: string }> {
    const constitution = this.load()
    const violations: Array<{ principle: ConstitutionalPrinciple; match: string }> = []

    for (const principle of constitution.principles) {
      if (!principle.audit_pattern) continue
      try {
        const regex = new RegExp(principle.audit_pattern, 'gi')
        let match: RegExpExecArray | null
        while ((match = regex.exec(content)) !== null) {
          violations.push({ principle, match: match[0] })
        }
      } catch {
        // Invalid regex in audit_pattern — skip
      }
    }

    return violations
  }

  /** Get the constitution path (for display). */
  getPath(): string {
    return this.path
  }

  // ── Private ──

  /** Minimal YAML parser for constitution format (flat key-values + list items). */
  private parseYaml(raw: string): MiphamConstitution {
    const lines = raw.split('\n')
    const result: MiphamConstitution = { version: '0.0.0', last_modified: '', principles: [] }
    let currentPrinciple: Partial<ConstitutionalPrinciple> | null = null
    let inPrinciples = false

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      // Top-level keys
      if (!trimmed.startsWith('-') && !trimmed.startsWith('  ')) {
        const kv = trimmed.match(/^(\w[\w_]*):\s*(.*)$/)
        if (kv) {
          const key = kv[1]!
          const val = kv[2]!.trim().replace(/^['"]|['"]$/g, '')
          if (key === 'version') result.version = val
          else if (key === 'last_modified') result.last_modified = val
          if (key === 'principles') inPrinciples = true
        }
        continue
      }

      // List items in principles
      if (inPrinciples && trimmed === '- id:') {
        continue
      }

      if (inPrinciples && trimmed.startsWith('- ')) {
        // New principle entry
        if (currentPrinciple && currentPrinciple.id) {
          result.principles.push(currentPrinciple as ConstitutionalPrinciple)
        }
        currentPrinciple = {}
        const kv = trimmed.substring(2).match(/^(\w[\w_]*):\s*(.*)$/)
        if (kv) {
          const key = kv[1]!
          const val = kv[2]!.trim().replace(/^['"]|['"]$/g, '')
          this.setPrincipleField(currentPrinciple, key, val)
        }
        continue
      }

      // Indented fields of current principle
      if (inPrinciples && trimmed.startsWith('  ') && currentPrinciple) {
        const kv = trimmed.match(/^\s{2}(\w[\w_]*):\s*(.*)$/)
        if (kv) {
          const key = kv[1]!
          const val = kv[2]!.trim().replace(/^['"]|['"]$/g, '')
          this.setPrincipleField(currentPrinciple, key, val)
        }
      }
    }

    // Push last principle
    if (currentPrinciple && currentPrinciple.id) {
      result.principles.push(currentPrinciple as ConstitutionalPrinciple)
    }

    return result
  }

  private setPrincipleField(p: Partial<ConstitutionalPrinciple>, key: string, val: string): void {
    switch (key) {
      case 'id':
        p.id = val
        break
      case 'text':
        p.text = val
        break
      case 'enforce':
        p.enforce = val as ConstitutionalPrinciple['enforce']
        break
      case 'audit_pattern':
        p.audit_pattern = val
        break
      case 'scope':
        p.scope = val
        break
      case 'hook':
        p.hook = val as ConstitutionalPrinciple['hook']
        break
      case 'tools':
        p.tools = val
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((t) => t.trim())
        break
      case 'rationale':
        p.rationale = val
        break
      case 'facet':
        p.facet = val
        break
    }
  }

  private validate(constitution: MiphamConstitution): boolean {
    return (
      !!constitution.version &&
      Array.isArray(constitution.principles) &&
      constitution.principles.length > 0 &&
      constitution.principles.every((p) => !!p.id && !!p.text && !!p.enforce)
    )
  }

  /** Serialize a constitution back to YAML for writing to disk. */
  private serializeToYaml(constitution: MiphamConstitution): string {
    const lines: string[] = [
      `# Mipham AI Guardrails v${constitution.version}`,
      '#',
      '# Machine-readable ethical & safety principles enforced at runtime.',
      '# Inspired by Anthropic Constitutional AI.',
      '#',
      '# Edit this file to customize principles. Delete it to restore defaults.',
      '# Changes take effect after /constitution reload or session restart.',
      '',
      `version: "${constitution.version}"`,
      `last_modified: "${constitution.last_modified}"`,
      '',
      'principles:',
    ]

    for (const p of constitution.principles) {
      lines.push(`  - id: "${p.id}"`)
      lines.push(`    text: "${p.text}"`)
      lines.push(`    enforce: ${p.enforce}`)
      if (p.facet) lines.push(`    facet: ${p.facet}`)
      if (p.audit_pattern) lines.push(`    audit_pattern: "${p.audit_pattern}"`)
      if (p.scope) lines.push(`    scope: "${p.scope}"`)
      if (p.hook) lines.push(`    hook: ${p.hook}`)
      if (p.tools) lines.push(`    tools: [${p.tools.join(', ')}]`)
      if (p.rationale) lines.push(`    rationale: "${p.rationale}"`)
    }

    return lines.join('\n') + '\n'
  }
}
