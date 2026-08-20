import { describe, it, expect } from 'vitest'
import { checkSkillShadow } from '../../src/skills/sanitizer'

describe('checkSkillShadow', () => {
  it('flags a skill whose name shadows a builtin command (slash-normalized)', () => {
    // skillName has no leading slash; BUILTIN_COMMANDS stores '/help' etc.
    expect(checkSkillShadow('help', '').shadowed).toBe(true)
    expect(checkSkillShadow('crsi', '').shadowed).toBe(true)
    expect(checkSkillShadow('help', '').conflictsWith).toBe('help')
    expect(checkSkillShadow('help', '').conflictType).toBe('command')
  })

  it('does not flag non-shadowing names', () => {
    expect(checkSkillShadow('save', '').shadowed).toBe(false)
    expect(checkSkillShadow('wiki', '').shadowed).toBe(false)
    // 'triage' 是真实 skill（user-invocable），/triage 已从 BUILTIN_COMMANDS 移除
    expect(checkSkillShadow('triage', '').shadowed).toBe(false)
  })
})
