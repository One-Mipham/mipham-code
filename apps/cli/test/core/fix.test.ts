import { describe, it, expect } from 'vitest'
import {
  computeDoctorFix,
  findCorruptJsonlLines,
  removeCorruptLines,
  selectRepoClaudeFiles,
  fixDoctor,
  fixConfig,
  fixCache,
} from '../../src/core/fix'
import { parseFrontmatter, parsePromptExclude } from '../../src/core/instructions'

function excluded(content: string): string[] {
  const { data } = parseFrontmatter(content)
  return parsePromptExclude(data['prompt-exclude'])
}

describe('computeDoctorFix', () => {
  it('returns null when there are no derivable sections', () => {
    const content = '## 架构设计\n## 关键约束\n'
    expect(computeDoctorFix(content)).toBeNull()
  })

  it('returns fixed content listing the derivable headings', () => {
    const content = '## 技术栈\nNode.js\n## 项目一览\nfoo\n'
    const result = computeDoctorFix(content)

    expect(result).not.toBeNull()
    expect(result!.added).toEqual(['技术栈', '项目一览'])
    expect(excluded(result!.content)).toEqual(['技术栈', '项目一览'])
  })

  it('returns null when every derivable section is already excluded', () => {
    const content = '---\nprompt-exclude:\n  - 技术栈\n---\n## 技术栈\nNode.js\n'
    expect(computeDoctorFix(content)).toBeNull()
  })
})

describe('findCorruptJsonlLines', () => {
  it('returns line numbers that are not valid JSON', () => {
    const content = '{"a":1}\nnot json\n{"b":2}\n'
    expect(findCorruptJsonlLines(content)).toEqual([1])
  })

  it('ignores blank and whitespace-only lines', () => {
    const content = '{"a":1}\n\n   \n{"b":2}\n'
    expect(findCorruptJsonlLines(content)).toEqual([])
  })

  it('returns empty for a fully valid file', () => {
    expect(findCorruptJsonlLines('{"a":1}\n{"b":2}\n')).toEqual([])
  })
})

describe('removeCorruptLines', () => {
  it('removes only the given line numbers', () => {
    const content = '{"a":1}\nbad\n{"b":2}\n'
    expect(removeCorruptLines(content, [1])).toBe('{"a":1}\n{"b":2}\n')
  })
})

describe('selectRepoClaudeFiles', () => {
  it('selects only project/directory CLAUDE.md', () => {
    const files = [
      { path: '/root/CLAUDE.md', level: 'project' },
      { path: '/root/sub/CLAUDE.md', level: 'directory' },
      { path: '/company/CLAUDE.md', level: 'company' },
      { path: '/root/MIPHAM.md', level: 'project' },
      { path: '/home/USER.md', level: 'user' },
    ]
    expect(selectRepoClaudeFiles(files).map((f) => f.path)).toEqual([
      '/root/CLAUDE.md',
      '/root/sub/CLAUDE.md',
    ])
  })
})

describe('fixDoctor', () => {
  it('reads, fixes, and writes each derivable file', () => {
    const reads: Record<string, string> = { '/a/CLAUDE.md': '## 技术栈\nNode\n' }
    const writes: Array<{ path: string; content: string }> = []
    const report = fixDoctor([{ path: '/a/CLAUDE.md' }], {
      read: (p) => reads[p] ?? null,
      write: (p, c) => writes.push({ path: p, content: c }),
    })

    expect(report.fixed).toEqual([{ path: '/a/CLAUDE.md', added: ['技术栈'] }])
    expect(writes.length).toBe(1)
  })

  it('skips files with no derivable sections', () => {
    const writes: Array<{ path: string; content: string }> = []
    const report = fixDoctor([{ path: '/a/CLAUDE.md' }], {
      read: () => '## 架构\n',
      write: (p, c) => writes.push({ path: p, content: c }),
    })

    expect(report.fixed).toEqual([])
    expect(writes.length).toBe(0)
  })

  it('skips files that cannot be read', () => {
    const writes: Array<{ path: string; content: string }> = []
    const report = fixDoctor([{ path: '/gone/CLAUDE.md' }], {
      read: () => null,
      write: (p, c) => writes.push({ path: p, content: c }),
    })

    expect(report.fixed).toEqual([])
    expect(writes.length).toBe(0)
  })
})

describe('fixConfig', () => {
  it('restores corrupt configs and re-enables disabled hooks', () => {
    const restored: string[] = []
    const report = fixConfig({
      configPaths: ['/proj/config.yml'],
      read: () => 'not: [valid yaml',
      parseYaml: () => {
        throw new Error('bad yaml')
      },
      restore: (p) => {
        restored.push(p)
        return true
      },
      hookHealth: () => [
        { key: 'a', disabled: true },
        { key: 'b', disabled: false },
      ],
      reEnableHook: (k) => k === 'a',
    })

    expect(report.corruptConfigs).toEqual(['/proj/config.yml'])
    expect(report.restoredConfigs).toEqual(['/proj/config.yml'])
    expect(report.disabledHooks).toEqual(['a'])
    expect(report.reenabledHooks).toEqual(['a'])
  })

  it('leaves healthy configs and hooks untouched', () => {
    let restoreCalls = 0
    const report = fixConfig({
      configPaths: ['/proj/config.yml'],
      read: () => 'provider: x',
      parseYaml: () => ({ provider: 'x' }),
      restore: () => {
        restoreCalls++
        return false
      },
      hookHealth: () => [],
      reEnableHook: () => false,
    })

    expect(report.corruptConfigs).toEqual([])
    expect(report.restoredConfigs).toEqual([])
    expect(report.disabledHooks).toEqual([])
    expect(report.reenabledHooks).toEqual([])
    expect(restoreCalls).toBe(0)
  })

  it('detects but does not repair in dry-run mode', () => {
    let restoreCalls = 0
    let reenableCalls = 0
    const report = fixConfig({
      configPaths: ['/proj/config.yml'],
      read: () => 'broken yaml',
      parseYaml: () => {
        throw new Error('bad')
      },
      restore: () => {
        restoreCalls++
        return true
      },
      hookHealth: () => [{ key: 'a', disabled: true }],
      reEnableHook: () => {
        reenableCalls++
        return true
      },
      dryRun: true,
    })

    expect(report.corruptConfigs).toEqual(['/proj/config.yml'])
    expect(report.restoredConfigs).toEqual([])
    expect(report.disabledHooks).toEqual(['a'])
    expect(report.reenabledHooks).toEqual([])
    expect(restoreCalls).toBe(0)
    expect(reenableCalls).toBe(0)
  })
})

describe('fixCache', () => {
  it('reports corrupt lines without writing when apply is false', () => {
    const writes: Array<{ path: string; content: string }> = []
    const report = fixCache(
      ['/c/eval.jsonl'],
      {
        read: () => '{"a":1}\nbad\n',
        write: (p, c) => writes.push({ path: p, content: c }),
      },
      false,
    )

    expect(report.files).toEqual([{ path: '/c/eval.jsonl', corruptLines: [1] }])
    expect(writes.length).toBe(0)
  })

  it('cleans corrupt lines when apply is true', () => {
    const writes: Array<{ path: string; content: string }> = []
    fixCache(
      ['/c/eval.jsonl'],
      {
        read: () => '{"a":1}\nbad\n',
        write: (p, c) => writes.push({ path: p, content: c }),
      },
      true,
    )

    expect(writes.length).toBe(1)
    expect(writes[0]!.content).toBe('{"a":1}\n')
  })

  it('skips missing files', () => {
    const report = fixCache(['/c/missing.jsonl'], { read: () => null, write: () => {} }, false)
    expect(report.files).toEqual([])
  })
})
