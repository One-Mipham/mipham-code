/**
 * CLAUDE.md fix — write the derivable-section headings that `findDerivableSections`
 * flags into the document's `prompt-exclude` frontmatter, so `stripSections` stops
 * injecting them into the system prompt every session.
 */
import { stringify as stringifyYaml } from 'yaml'
import { parseFrontmatter, parsePromptExclude } from './instructions'

export interface ApplyPromptExcludeResult {
  content: string
  added: string[]
}

/**
 * Merge `headings` into the document's `prompt-exclude` frontmatter (creating the
 * frontmatter block if absent). Preserves existing exclusions and other frontmatter
 * fields; reports only the headings that were actually new.
 */
export function applyPromptExclude(content: string, headings: string[]): ApplyPromptExcludeResult {
  const { data, content: body } = parseFrontmatter(content)
  const existing = parsePromptExclude(data['prompt-exclude'])
  const added = [...new Set(headings)].filter((h) => !existing.includes(h))
  if (added.length === 0) return { content, added: [] }

  data['prompt-exclude'] = [...existing, ...added]
  const frontmatter = stringifyYaml(data)
  return { content: `---\n${frontmatter}---\n${body}`, added }
}
