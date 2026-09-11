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

  // Regression: macOS Backspace sends \x7f, which Ink 5.2.1 parses as key.delete
  // (not key.backspace, which is \x08). Treating key.delete as a forward delete
  // made Backspace a no-op at the end of the line.
  it('treats key.delete as a backward delete (macOS Backspace is \\x7f)', () => {
    expect(keyToEditAction({ delete: true }, '')).toEqual({ type: 'backspace' })
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
