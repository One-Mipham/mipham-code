/**
 * OutputStylesLoader — loads custom response persona styles from .mipham/output-styles/.
 *
 * Each .md file in the directory is a named style. The active style's content
 * is injected into the system prompt to shape the AI's tone and communication style.
 *
 * Usage:
 *   const loader = new OutputStylesLoader(cwd)
 *   loader.list()               // ['concise', 'academic', ...]
 *   loader.get('concise')       // style content or undefined
 *   loader.setActive('concise') // switch active style
 *   loader.getActiveContent()   // active style content (for system prompt)
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

export class OutputStylesLoader {
  private stylesDir: string
  private activeStyle: string | null = null

  constructor(cwd: string) {
    this.stylesDir = join(cwd, '.mipham', 'output-styles')
  }

  /**
   * List all available style names (filename without .md extension).
   */
  list(): string[] {
    if (!existsSync(this.stylesDir)) return []
    try {
      return readdirSync(this.stylesDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => basename(f, extname(f)))
    } catch {
      return []
    }
  }

  /**
   * Get the content of a named style. Returns undefined if not found.
   */
  get(name: string): string | undefined {
    if (!existsSync(this.stylesDir)) return undefined
    const filepath = join(this.stylesDir, `${name}.md`)
    if (!existsSync(filepath)) return undefined
    try {
      return readFileSync(filepath, 'utf-8').trim()
    } catch {
      return undefined
    }
  }

  /**
   * Set the active output style.
   */
  setActive(name: string): boolean {
    const content = this.get(name)
    if (!content) return false
    this.activeStyle = name
    return true
  }

  /**
   * Clear the active output style (revert to default personality).
   */
  clearActive(): void {
    this.activeStyle = null
  }

  /**
   * Get the active style name (null if none selected).
   */
  getActiveName(): string | null {
    return this.activeStyle
  }

  /**
   * Get the active style content for system prompt injection.
   * Returns empty string if no style is active.
   */
  getActiveContent(): string {
    if (!this.activeStyle) return ''
    const content = this.get(this.activeStyle)
    if (!content) return ''
    return [
      `[Output Style: ${this.activeStyle}]`,
      'Adopt the following communication style in all your responses:',
      '',
      content,
      '',
      '---',
    ].join('\n')
  }
}
