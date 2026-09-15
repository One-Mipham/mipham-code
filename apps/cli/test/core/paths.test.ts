import { describe, it, expect } from 'vitest'
import { worktreeRoot, worktreeRoots, findWorktreeMarker } from '../../src/core/paths'

describe('worktreeRoot', () => {
  it('builds the path under .mipham/', () => {
    expect(worktreeRoot('/proj')).toBe('/proj/.mipham/worktrees')
  })
})

describe('worktreeRoots', () => {
  it('lists the new root first and the legacy root second', () => {
    expect(worktreeRoots('/proj')).toEqual(['/proj/.mipham/worktrees', '/proj/.claude/worktrees'])
  })
})

describe('findWorktreeMarker', () => {
  it('locates the project root from a .mipham worktree cwd', () => {
    expect(findWorktreeMarker('/proj/.mipham/worktrees/w1')).toEqual({
      root: '/proj',
      marker: '.mipham/worktrees/',
    })
  })

  it('locates the project root from a legacy .claude worktree cwd', () => {
    expect(findWorktreeMarker('/proj/.claude/worktrees/w1')).toEqual({
      root: '/proj',
      marker: '.claude/worktrees/',
    })
  })

  it('locates the root from a nested directory inside a worktree', () => {
    expect(findWorktreeMarker('/proj/.mipham/worktrees/w1/src/deep')?.root).toBe('/proj')
  })

  it('returns null when cwd is not inside a worktree', () => {
    expect(findWorktreeMarker('/proj/src')).toBeNull()
  })

  it('returns null for the project root itself', () => {
    expect(findWorktreeMarker('/proj')).toBeNull()
  })
})
