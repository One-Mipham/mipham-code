import { describe, it, expect } from 'vitest'
import { compileRule, validateRulePattern, mcpServerPrefix } from '../../src/core/permission-rules'

// Whole-server MCP rules. Two failure modes used to coexist:
//   `mcp__server__*` failed `^\w+$` and was warned as invalid;
//   `mcp__server` passed, compiled to `^mcp__server$`, and could never match
//   `mcp__server__tool` — a silent dead rule (the class 0.85.22 fixed for bare
//   tool names, reached through the `mcp__` exemption).

describe('mcpServerPrefix', () => {
  it('recognizes the bare server form', () => {
    expect(mcpServerPrefix('mcp__forge')).toBe('mcp__forge__')
  })

  it('recognizes the wildcard form', () => {
    expect(mcpServerPrefix('mcp__forge__*')).toBe('mcp__forge__')
  })

  it('lowercases the server segment, matching sanitizeName', () => {
    expect(mcpServerPrefix('mcp__Forge')).toBe('mcp__forge__')
  })

  it('does not treat a full tool name as a server rule', () => {
    expect(mcpServerPrefix('mcp__forge__search')).toBeNull()
  })

  it('ignores non-mcp and malformed names', () => {
    expect(mcpServerPrefix('Bash')).toBeNull()
    expect(mcpServerPrefix('mcp__')).toBeNull()
    expect(mcpServerPrefix('mcp__bad server')).toBeNull()
  })
})

describe('MCP whole-server rules validate and compile to a prefix match', () => {
  it.each(['mcp__forge', 'mcp__forge__*'])('%s is valid', (pattern) => {
    expect(validateRulePattern(pattern)).toBeNull()
  })

  it.each(['mcp__forge', 'mcp__forge__*'])('%s matches every tool on the server', (pattern) => {
    const rule = compileRule(pattern, 'allow')
    expect(rule.invalid).toBeUndefined()
    expect(rule.compiled.test('mcp__forge__search')).toBe(true)
    expect(rule.compiled.test('mcp__forge__write')).toBe(true)
    // Prefix, not substring: a different server sharing the prefix must not match.
    expect(rule.compiled.test('mcp__forge2__search')).toBe(false)
    expect(rule.compiled.test('mcp__other__search')).toBe(false)
  })

  it('a full tool name stays exact', () => {
    const rule = compileRule('mcp__forge__search', 'allow')
    expect(rule.invalid).toBeUndefined()
    expect(rule.compiled.test('mcp__forge__search')).toBe(true)
    expect(rule.compiled.test('mcp__forge__write')).toBe(false)
  })

  it('uppercase server names match the lowercased registered names', () => {
    expect(compileRule('mcp__Forge', 'allow').compiled.test('mcp__forge__search')).toBe(true)
  })
})
