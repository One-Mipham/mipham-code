import { describe, it, expect } from 'vitest'
import { applyEdit } from '../../src/ui/input'

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
