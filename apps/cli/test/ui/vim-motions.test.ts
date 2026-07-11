import { describe, it, expect } from 'vitest'
import { VimMotionEngine } from '../../src/ui/vim-motions.js'

// ── Helpers ──

function engine() {
  return new VimMotionEngine()
}

// ── Tests ──

describe('VimMotionEngine', () => {
  // ═══════════════════════════════════════════
  // Mode
  // ═══════════════════════════════════════════

  it('should start in insert mode by default', () => {
    const e = engine()
    expect(e.mode).toBe('insert')
  })

  it('should allow toggling to normal mode', () => {
    const e = engine()
    e.mode = 'normal'
    expect(e.mode).toBe('normal')
  })

  // ═══════════════════════════════════════════
  // Basic motions: h, l
  // ═══════════════════════════════════════════

  it('should move cursor left with h', () => {
    const e = engine()
    const action = e.handleNormal('h', 'hello', 3)
    expect(action).toEqual({ cursor: 2 })
  })

  it('should move cursor right with l', () => {
    const e = engine()
    const action = e.handleNormal('l', 'hello', 2)
    expect(action).toEqual({ cursor: 3 })
  })

  // ═══════════════════════════════════════════
  // Line boundaries: 0, $
  // ═══════════════════════════════════════════

  it('should move cursor to start of line with 0', () => {
    const e = engine()
    const action = e.handleNormal('0', 'hello world', 7)
    expect(action).toEqual({ cursor: 0 })
  })

  it('should move cursor to end of line with $', () => {
    const e = engine()
    const action = e.handleNormal('$', 'hello world', 3)
    expect(action).toEqual({ cursor: 11 })
  })

  // ═══════════════════════════════════════════
  // Word motions: w, b
  // ═══════════════════════════════════════════

  it('should move cursor to next word with w', () => {
    const e = engine()
    // "hello world" — cursor at 0 (h), w should jump to 'w' at 6
    const action = e.handleNormal('w', 'hello world', 0)
    expect(action).toEqual({ cursor: 6 })
  })

  it('should move cursor to previous word with b', () => {
    const e = engine()
    // "hello world" — cursor at 6 (w), b should jump to 'h' at 0
    const action = e.handleNormal('b', 'hello world', 6)
    expect(action).toEqual({ cursor: 0 })
  })

  it('should handle w at end of line', () => {
    const e = engine()
    const action = e.handleNormal('w', 'hi', 2)
    expect(action).toEqual({ cursor: 2 })
  })

  it('should handle b at start of line', () => {
    const e = engine()
    const action = e.handleNormal('b', 'hi', 0)
    expect(action).toEqual({ cursor: 0 })
  })

  // ═══════════════════════════════════════════
  // Multi-word w/b
  // ═══════════════════════════════════════════

  it('should skip multiple words with w', () => {
    const e = engine()
    // "one two three" — cursor at 0
    const a1 = e.handleNormal('w', 'one two three', 0)
    expect(a1).toEqual({ cursor: 4 }) // after 'one' -> before 'two'

    const a2 = e.handleNormal('w', 'one two three', 4)
    expect(a2).toEqual({ cursor: 8 }) // after 'two' -> before 'three'
  })

  it('should skip multiple words backward with b', () => {
    const e = engine()
    // "one two three" — cursor at 8 (start of 'three')
    const a1 = e.handleNormal('b', 'one two three', 8)
    expect(a1).toEqual({ cursor: 4 }) // start of 'two'

    const a2 = e.handleNormal('b', 'one two three', 4)
    expect(a2).toEqual({ cursor: 0 }) // start of 'one'
  })

  // ═══════════════════════════════════════════
  // Pending motions: d, y
  // ═══════════════════════════════════════════

  it('should return pending for d', () => {
    const e = engine()
    const action = e.handleNormal('d', 'hello', 0)
    expect(action).toEqual({ pending: 'd' })
  })

  it('should return pending for y', () => {
    const e = engine()
    const action = e.handleNormal('y', 'hello', 0)
    expect(action).toEqual({ pending: 'y' })
  })

  // ═══════════════════════════════════════════
  // dd — delete entire line
  // ═══════════════════════════════════════════

  it('should delete entire line with dd', () => {
    const e = engine()
    const action = e.handleDD('hello world')
    expect(action).toEqual({ text: '', cursor: 0 })
  })

  it('should copy deleted text to clipboard', () => {
    const e = engine()
    e.handleDD('hello world')
    // Paste should restore the deleted text
    const action = e.handlePaste('', 0)
    expect(action).toEqual({ text: 'hello world', cursor: 11 })
  })

  // ═══════════════════════════════════════════
  // yy — yank entire line
  // ═══════════════════════════════════════════

  it('should yank entire line without changing text', () => {
    const e = engine()
    const action = e.handleYY('hello world')
    expect(action).toEqual({ cursor: 0 })
  })

  it('should paste yanked text', () => {
    const e = engine()
    e.handleYY('hello')
    const action = e.handlePaste(' world', 0)
    expect(action).toEqual({ text: 'hello world', cursor: 5 })
  })

  // ═══════════════════════════════════════════
  // p — paste
  // ═══════════════════════════════════════════

  it('should paste clipboard content after cursor', () => {
    const e = engine()
    e.handleYY('hello')
    const action = e.handlePaste('prefix ', 7)
    expect(action).toEqual({ text: 'prefix hello', cursor: 12 })
  })

  it('should paste before cursor when cursor is at start', () => {
    const e = engine()
    e.handleDD('old')
    // Clipboard now has 'old'
    const action = e.handlePaste('new', 0)
    expect(action).toEqual({ text: 'oldnew', cursor: 3 })
  })

  // ═══════════════════════════════════════════
  // u — undo
  // ═══════════════════════════════════════════

  it('should undo to previous text', () => {
    const e = engine()
    e.handleDD('hello world') // pushes 'hello world' to undo stack
    const action = e.handleUndo('')
    expect(action).toEqual({ text: 'hello world', cursor: 11 })
  })

  it('should return current cursor at end when undo stack is empty', () => {
    const e = engine()
    const action = e.handleUndo('hello')
    expect(action).toEqual({ cursor: 5 })
  })

  it('should support multiple undo steps', () => {
    const e = engine()
    // dd pushes text to undo stack
    e.handleDD('first line')
    const a1 = e.handleUndo('')
    expect(a1).toEqual({ text: 'first line', cursor: 10 })

    // Empty undo stack now
    const a2 = e.handleUndo(a1.text!)
    expect(a2).toEqual({ cursor: 10 })
  })

  // ═══════════════════════════════════════════
  // / — search
  // ═══════════════════════════════════════════

  it('should find search query and move cursor', () => {
    const e = engine()
    const action = e.handleSearch('hello world', 'world')
    expect(action).toEqual({ cursor: 6 })
  })

  it('should stay at 0 when query not found', () => {
    const e = engine()
    const action = e.handleSearch('hello world', 'xyz')
    expect(action).toEqual({ cursor: 0 })
  })

  it('should find first occurrence of query', () => {
    const e = engine()
    const action = e.handleSearch('hello hello', 'hello')
    expect(action).toEqual({ cursor: 0 })
  })

  // ═══════════════════════════════════════════
  // Repeat find: ; / ,
  // ═══════════════════════════════════════════

  it('should repeat last find forward', () => {
    const e = engine()
    // "hello world hello" — find next 'o' after cursor at 0
    const action = e.handleRepeat('hello world hello', 'o', 0)
    expect(action).toEqual({ cursor: 4 }) // 'o' in 'hello'
  })

  it('should stay at cursor when repeat find misses', () => {
    const e = engine()
    const action = e.handleRepeat('hello world', 'z', 0)
    expect(action).toEqual({ cursor: 0 })
  })

  // ═══════════════════════════════════════════
  // Unknown keys
  // ═══════════════════════════════════════════

  it('should return null for unknown keys in normal mode', () => {
    const e = engine()
    const action = e.handleNormal('x', 'hello', 2)
    expect(action).toBeNull()
  })
})
