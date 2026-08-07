import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const MAX_EXPERIENCES = 20

export class AgentExperience {
  private readonly expFile: string
  private readonly expDir: string

  constructor(
    private readonly agentName: string,
    baseDir: string = join(process.env.HOME || '~', '.mipham', 'agent-memory'),
  ) {
    this.expDir = join(baseDir, agentName)
    this.expFile = join(this.expDir, 'experience.md')
  }

  logSuccess(description: string, whenToApply: string): void {
    const date = new Date().toISOString().slice(0, 10)
    const entry = `- [${date}] ${description}\n  **When to apply:** ${whenToApply}\n`
    this.appendToSection('## Success Patterns', entry)
    this.incrementStat('success')
  }

  logFailure(description: string, whenToAvoid: string): void {
    const date = new Date().toISOString().slice(0, 10)
    const entry = `- [${date}] ${description}\n  **When to avoid:** ${whenToAvoid}\n`
    this.appendToSection('## Failure Patterns', entry)
    this.incrementStat('failure')
  }

  getExperience(): string {
    if (!existsSync(this.expFile)) return ''
    try {
      return readFileSync(this.expFile, 'utf-8')
    } catch {
      return ''
    }
  }

  reset(): void {
    if (existsSync(this.expFile)) {
      try {
        unlinkSync(this.expFile)
      } catch {
        /* ok */
      }
    }
  }

  private appendToSection(section: string, entry: string): void {
    mkdirSync(this.expDir, { recursive: true })

    let content = this.getExperience()
    if (!content) {
      content = `# Agent Experience — ${this.agentName}\n\n## Success Patterns\n\n## Failure Patterns\n\n## Stats\n- 总执行: 0 次 | 成功: 0 | 失败: 0\n`
    }

    // Find section and append entry
    const sectionIndex = content.indexOf(section)
    if (sectionIndex === -1) {
      // Section missing — add before Stats
      const statsIndex = content.indexOf('## Stats')
      if (statsIndex !== -1) {
        content = content.slice(0, statsIndex) + `${section}\n${entry}\n` + content.slice(statsIndex)
      } else {
        content += `\n${section}\n${entry}\n`
      }
    } else {
      // Find next section header after this one
      const nextSection = content.indexOf('\n## ', sectionIndex + section.length)
      const insertAt = nextSection !== -1 ? nextSection : content.length
      content = content.slice(0, insertAt) + entry + content.slice(insertAt)
    }

    // Trim old entries if over limit
    const lines = content.split('\n')
    const entries = lines.filter((l) => l.startsWith('- ['))
    if (entries.length > MAX_EXPERIENCES) {
      // Remove oldest entry (first one found)
      const firstEntryIdx = lines.findIndex((l) => l.startsWith('- ['))
      if (firstEntryIdx !== -1) {
        const nextEntryLine = lines[firstEntryIdx + 1]
        const removeCount = nextEntryLine?.startsWith('  **') ? 2 : 1
        lines.splice(firstEntryIdx, removeCount)
        content = lines.join('\n')
      }
    }

    writeFileSync(this.expFile, content, 'utf-8')
  }

  private incrementStat(type: 'success' | 'failure'): void {
    let content = this.getExperience()
    if (!content) {
      // Initialize with headers
      content = `# Agent Experience — ${this.agentName}\n\n## Success Patterns\n\n## Failure Patterns\n\n## Stats\n- 总执行: 0 次 | 成功: 0 | 失败: 0\n`
    }

    // Replace stats line
    content = content.replace(
      /- 总执行: (\d+) 次 \| 成功: (\d+) \| 失败: (\d+)/,
      (_match, total: string, success: string, failure: string) => {
        const newTotal = parseInt(total) + 1
        const newSuccess = type === 'success' ? parseInt(success) + 1 : parseInt(success)
        const newFailure = type === 'failure' ? parseInt(failure) + 1 : parseInt(failure)
        return `- 总执行: ${newTotal} 次 | 成功: ${newSuccess} | 失败: ${newFailure}`
      },
    )

    writeFileSync(this.expFile, content, 'utf-8')
  }
}
