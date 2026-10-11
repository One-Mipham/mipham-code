import { describe, it, expect } from 'vitest'
import { applyEdit, keyToEditAction, navigateHistory } from '../../src/ui/input'

describe('applyEdit', () => {
  it('moveLeft clamps at 0', () => {
    expect(applyEdit({ value: 'ab', cursor: 0 }, { type: 'moveLeft' })).toEqual({
      value: 'ab',
      cursor: 0,
    })
  })

  it('moveRight clamps at value.length', () => {
    expect(applyEdit({ value: 'ab', cursor: 2 }, { type: 'moveRight' })).toEqual({
      value: 'ab',
      cursor: 2,
    })
  })

  it('moves the cursor left and right within the line', () => {
    const movedLeft = applyEdit({ value: 'abc', cursor: 2 }, { type: 'moveLeft' })
    expect(movedLeft).toEqual({ value: 'abc', cursor: 1 })
    expect(applyEdit(movedLeft, { type: 'moveRight' })).toEqual({ value: 'abc', cursor: 2 })
  })

  it('backspace deletes the char before the cursor and moves left', () => {
    expect(applyEdit({ value: 'abc', cursor: 2 }, { type: 'backspace' })).toEqual({
      value: 'ac',
      cursor: 1,
    })
  })

  it('backspace at position 0 is a no-op', () => {
    expect(applyEdit({ value: 'abc', cursor: 0 }, { type: 'backspace' })).toEqual({
      value: 'abc',
      cursor: 0,
    })
  })

  it('delete removes the char at the cursor without moving it', () => {
    expect(applyEdit({ value: 'abc', cursor: 1 }, { type: 'delete' })).toEqual({
      value: 'ac',
      cursor: 1,
    })
  })

  it('delete at the end is a no-op', () => {
    expect(applyEdit({ value: 'abc', cursor: 3 }, { type: 'delete' })).toEqual({
      value: 'abc',
      cursor: 3,
    })
  })

  it('insert appends at the end and advances the cursor', () => {
    expect(applyEdit({ value: 'ab', cursor: 2 }, { type: 'insert', text: 'c' })).toEqual({
      value: 'abc',
      cursor: 3,
    })
  })

  it('insert in the middle places text at the cursor, not the end', () => {
    expect(applyEdit({ value: 'ac', cursor: 1 }, { type: 'insert', text: 'b' })).toEqual({
      value: 'abc',
      cursor: 2,
    })
  })
})

describe('keyToEditAction', () => {
  it('maps left/right arrows to cursor moves', () => {
    expect(keyToEditAction({ leftArrow: true }, '')).toEqual({ type: 'moveLeft' })
    expect(keyToEditAction({ rightArrow: true }, '')).toEqual({ type: 'moveRight' })
  })

  it('maps backspace to a backward delete', () => {
    expect(keyToEditAction({ backspace: true }, '')).toEqual({ type: 'backspace' })
  })

  // Ink 7 distinguishes the physical Backspace (\x7f → key.backspace) from the
  // forward-Delete key (\x1b[3~ → key.delete). Ink 5.2.1 misparsed both as
  // key.delete, which made treating key.delete as forward-delete break Backspace;
  // that quirk is gone in Ink 7, so key.delete is forward delete again.
  it('maps key.delete to a forward delete (Ink 7 Delete key is \\x1b[3~)', () => {
    expect(keyToEditAction({ delete: true }, '')).toEqual({ type: 'delete' })
  })

  it('maps plain input to an insert at the cursor', () => {
    expect(keyToEditAction({}, 'a')).toEqual({ type: 'insert', text: 'a' })
  })

  it('returns null when no recognized key or input is present', () => {
    expect(keyToEditAction({}, '')).toBeNull()
  })
})

describe('navigateHistory', () => {
  const hist = ['first', 'second'] // submittedHistory order: [oldest, newest]

  it('returns null on up-arrow with empty history', () => {
    expect(navigateHistory({ history: [], index: -1, savedDraft: '' }, 'up', '')).toBeNull()
  })

  it('recalls the most recent message on first up-arrow and saves the draft', () => {
    expect(navigateHistory({ history: hist, index: -1, savedDraft: '' }, 'up', 'draft')).toEqual({
      index: 0,
      savedDraft: 'draft',
      value: 'second',
    })
  })

  it('walks further back on repeated up-arrows', () => {
    expect(
      navigateHistory({ history: hist, index: 0, savedDraft: 'draft' }, 'up', 'second'),
    ).toEqual({
      index: 1,
      savedDraft: 'draft',
      value: 'first',
    })
  })

  it('caps at the oldest message', () => {
    expect(
      navigateHistory({ history: hist, index: 1, savedDraft: 'draft' }, 'up', 'first'),
    ).toEqual({
      index: 1,
      savedDraft: 'draft',
      value: 'first',
    })
  })

  it('returns null on down-arrow when not browsing', () => {
    expect(navigateHistory({ history: hist, index: -1, savedDraft: '' }, 'down', '')).toBeNull()
  })

  it('walks back toward newer messages on down-arrow', () => {
    expect(
      navigateHistory({ history: hist, index: 1, savedDraft: 'draft' }, 'down', 'first'),
    ).toEqual({
      index: 0,
      savedDraft: 'draft',
      value: 'second',
    })
  })

  it('returns to the saved draft on down past the newest message', () => {
    expect(
      navigateHistory({ history: hist, index: 0, savedDraft: 'draft' }, 'down', 'second'),
    ).toEqual({
      index: -1,
      savedDraft: '',
      value: 'draft',
    })
  })
})

// ═══════════════════════════════════════════
// 295-055：光标按「用户看得见的一个字」步进，而不是 UTF-16 码元
// ═══════════════════════════════════════════
describe('applyEdit — 字素簇步进', () => {
  // macOS 文件名是 NFD：`é` 是 `e` + U+0301 组合重音，两个码元一个字符。
  const NFD_E = 'é'
  // 家庭 emoji：四个码点（含两个 ZWJ）作为一个字素簇。
  const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'
  // 单独的星形（代理对）—— 两个码元。
  const STAR = '\u{1F31F}'

  it('moveLeft 跨过一个 NFD 重音（停在字素边界，不停进字素内部）', () => {
    const value = `a${NFD_E}`
    expect(applyEdit({ value, cursor: value.length }, { type: 'moveLeft' })).toEqual({
      value,
      cursor: 1, // 'a' 之后，即字素簇起点；不是 value.length - 1
    })
  })

  it('backspace 一次删掉整个 NFD 字符（不是只删重音）', () => {
    const value = `a${NFD_E}`
    expect(applyEdit({ value, cursor: value.length }, { type: 'backspace' })).toEqual({
      value: 'a',
      cursor: 1,
    })
  })

  it('delete 一次删掉整个 NFD 字符', () => {
    const value = `a${NFD_E}b`
    expect(applyEdit({ value, cursor: 1 }, { type: 'delete' })).toEqual({
      value: 'ab',
      cursor: 1,
    })
  })

  it('moveLeft / moveRight 跨过代理对（emoji），不切断高低代理', () => {
    const value = `a${STAR}`
    const left = applyEdit({ value, cursor: value.length }, { type: 'moveLeft' })
    expect(left).toEqual({ value, cursor: 1 })
    expect(applyEdit(left, { type: 'moveRight' })).toEqual({ value, cursor: value.length })
  })

  it('backspace 一次删掉整个 ZWJ emoji 家族序列', () => {
    const value = `a${FAMILY}`
    expect(applyEdit({ value, cursor: value.length }, { type: 'backspace' })).toEqual({
      value: 'a',
      cursor: 1,
    })
  })

  it('（对照）纯 ASCII 步进与码元一致 —— 改前改后同结果', () => {
    expect(applyEdit({ value: 'abc', cursor: 3 }, { type: 'moveLeft' })).toEqual({
      value: 'abc',
      cursor: 2,
    })
    expect(applyEdit({ value: 'abc', cursor: 1 }, { type: 'backspace' })).toEqual({
      value: 'bc',
      cursor: 0,
    })
  })
})
