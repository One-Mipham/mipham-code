import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  worktreeRoot,
  worktreeRoots,
  findWorktreeMarker,
  workflowScriptDir,
  workflowScriptDirs,
} from '../../src/core/paths'

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

describe('workflowScriptDir', () => {
  it('builds the path under .mipham/', () => {
    expect(workflowScriptDir('/proj')).toBe('/proj/.mipham/workflows')
  })
})

describe('workflowScriptDirs', () => {
  it('lists every readable script location, writable root first', () => {
    expect(workflowScriptDirs('/proj')).toEqual([
      '/proj/.mipham/workflows', // new prefix — where scripts are written
      '/proj/.claude/workflows', // project-level legacy — read-only compat
      join(homedir(), '.claude', 'workflows'), // user-level legacy — read-only compat
    ])
  })

  it('never returns the run-artifact root', () => {
    // journal.ts keeps run journals and transcripts under
    // `~/.mipham/workflows/<runId>/`. Listing that root here would mix scripts
    // with run directories that merely share the name — the two are told apart
    // today only by a non-recursive readdir plus a `.js` filter, which is a
    // coincidence rather than a design.
    expect(workflowScriptDirs('/proj')).not.toContain(join(homedir(), '.mipham', 'workflows'))
  })
})
