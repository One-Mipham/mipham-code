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
 * Default location: ~/.mipham/constitution.yml
 * Format: YAML with schema validation
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

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
}

export interface MiphamConstitution {
  /** Semantic version for constitution changes */
  version: string
  /** Last modification date */
  last_modified: string
  /** The principles themselves */
  principles: ConstitutionalPrinciple[]
}

// ── Default Constitution ──

const DEFAULT_CONSTITUTION: MiphamConstitution = {
  version: '1.0.0',
  last_modified: '2026-08-12',
  principles: [
    {
      id: 'never-fabricate',
      text: '禁止编造数据、文件内容、API 响应或测试结果。每个输出必须可追溯至真实来源或明确标注为推测。',
      enforce: 'block',
      audit_pattern:
        '(fabricated|made.up|dummy.data|fake\s+(response|result|data)|placeholder\s+data)',
      scope: 'all-tools',
      rationale:
        'MiphamAI4S 科学诚信原则：编造数据是不可接受的底线违反。适用于所有工具和输出。',
    },
    {
      id: 'no-credential-leak',
      text: '禁止在代码、日志、配置文件、提交信息、对话输出中写入或泄露凭据、API 密钥、令牌。',
      enforce: 'block',
      audit_pattern: '(apiKey|api_key|password|secret|token|credential)\\s*[=:]\\s*[\'"][^\'"]{8,}',
      scope: 'Write,Edit,Bash',
      rationale: 'Rismed Ronxin Capital 合规要求：硬编码凭据违反安全底线。',
    },
    {
      id: 'minimal-change',
      text: '只修改被明确要求的文件和代码。不顺手改动相邻代码、格式或注释。不重构未损坏的代码。',
      enforce: 'warn',
      scope: 'Write,Edit',
      tools: ['Write', 'Edit'],
      rationale: 'AI 编码原则 #3（精准修改）：diff 中每一行改动都应可直接追溯到用户要求。',
    },
    {
      id: 'think-before-coding',
      text: '不确定时必须提问，不得自行假设。存在多种解读时呈现所有选项，不沉默选择一个。',
      enforce: 'warn',
      scope: 'pre-inference',
      hook: 'pre-inference',
      rationale: 'AI 编码原则 #1（编码前先思考）：偏差谨慎。',
    },
    {
      id: 'simplicity-first',
      text: '只写解决问题所需的最小代码。不添加未被要求的灵活性、可配置性或抽象层。',
      enforce: 'warn',
      scope: 'Write,Edit',
      tools: ['Write', 'Edit'],
      rationale: 'AI 编码原则 #2（简洁优先）：一次性代码不需要抽象层。',
    },
    {
      id: 'respect-permissions',
      text: '尊重用户权限设置。绝不绕过或降级权限检查。Bypass 模式仅限用户明确授权。',
      enforce: 'block',
      scope: 'all-tools',
      rationale: '权限系统是最后一道防线。任何绕过尝试都应被拦截并记录。',
    },
    {
      id: 'no-destructive-without-confirmation',
      text: '删除文件、强制推送、修改生产配置等破坏性操作前必须获得用户确认。',
      enforce: 'block',
      audit_pattern: '(rm\\s+-rf|git\\s+push\\s+--force|DROP\\s+TABLE|DELETE\\s+FROM)',
      scope: 'Bash',
      tools: ['Bash'],
      rationale: '防止不可逆操作。即使 bypass 模式也应二次确认。',
    },
    {
      id: 'persist-crsi-learning',
      text: '每次工具调用失败后必须记录 ErrorSignature 到 ErrorSignatureDB。从错误中持续学习。',
      enforce: 'auto',
      scope: 'post-tool-use',
      hook: 'post-tool-use',
      rationale: 'CRSI 核心机制：不重复犯同样的错误。自动执行，无需人类参与。',
    },
  ],
}

// ── Loader ──

export class ConstitutionLoader {
  private path: string
  private cached: MiphamConstitution | null = null

  constructor(customPath?: string) {
    this.path = customPath || join(homedir(), '.mipham', 'constitution.yml')
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
      const { writeFileSync, mkdirSync } = require('node:fs')
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
    let inList = false

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
        inList = true
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

  private setPrincipleField(
    p: Partial<ConstitutionalPrinciple>,
    key: string,
    val: string,
  ): void {
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
      `# Mipham Constitution v${constitution.version}`,
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
      if (p.audit_pattern) lines.push(`    audit_pattern: "${p.audit_pattern}"`)
      if (p.scope) lines.push(`    scope: "${p.scope}"`)
      if (p.hook) lines.push(`    hook: ${p.hook}`)
      if (p.tools) lines.push(`    tools: [${p.tools.join(', ')}]`)
      if (p.rationale) lines.push(`    rationale: "${p.rationale}"`)
    }

    return lines.join('\n') + '\n'
  }
}
