import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  renderClaudeMd,
  renderFullClaudeMd,
  renderReadmeMd,
  renderMiphamMd,
  renderContributingMd,
  renderLicenseMd,
  scaffoldProject,
  isEmptyProject,
} from '../../src/core/project-scaffold'

describe('renderMiphamMd', () => {
  it('renders a project personality doc with the project name and frontmatter', () => {
    const out = renderMiphamMd('my-app')
    expect(out).toContain('# MIPHAM.md — my-app')
    expect(out).toContain('privacy: project')
    expect(out).toContain('language: zh-CN')
  })
})

describe('renderClaudeMd', () => {
  it('renders a project CLAUDE.md with the name and governance constraints', () => {
    const out = renderClaudeMd('my-app')
    expect(out).toContain('# CLAUDE.md')
    expect(out).toContain('my-app')
    expect(out).toContain('Conventional Commits')
    expect(out).toContain('One Mipham Corporation')
  })
})

describe('renderReadmeMd', () => {
  it('renders a README with the name and a doc index', () => {
    const out = renderReadmeMd('my-app')
    expect(out).toContain('# my-app')
    expect(out).toContain('CLAUDE.md')
    expect(out).toContain('MIPHAM.md')
  })
})

describe('scaffoldProject', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mipham-scaffold-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates CLAUDE.md, MIPHAM.md, README.md in an empty dir', () => {
    const projectDir = join(tmpDir, 'proj')
    const result = scaffoldProject(projectDir)

    expect(result.created.sort()).toEqual(['CLAUDE.md', 'MIPHAM.md', 'README.md'].sort())
    expect(result.skipped).toEqual([])
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(projectDir, 'MIPHAM.md'))).toBe(true)
    expect(existsSync(join(projectDir, 'README.md'))).toBe(true)
  })

  it('skips files that already exist', () => {
    const projectDir = join(tmpDir, 'proj')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'README.md'), 'already here', 'utf-8')

    const result = scaffoldProject(projectDir)

    expect(result.created.sort()).toEqual(['CLAUDE.md', 'MIPHAM.md'].sort())
    expect(result.skipped).toEqual(['README.md'])
    // Existing file is left untouched
    expect(readFileSync(join(projectDir, 'README.md'), 'utf-8')).toBe('already here')
  })

  it('does not run git init by default', () => {
    const projectDir = join(tmpDir, 'proj')
    const result = scaffoldProject(projectDir)
    expect(result.gitInitialized).toBe(false)
    expect(existsSync(join(projectDir, '.git'))).toBe(false)
  })
})

describe('isEmptyProject', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mipham-empty-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns true for an empty directory', () => {
    expect(isEmptyProject(tmpDir)).toBe(true)
  })

  it('returns true for a directory containing only .DS_Store', () => {
    writeFileSync(join(tmpDir, '.DS_Store'), '', 'utf-8')
    expect(isEmptyProject(tmpDir)).toBe(true)
  })

  it('returns false when any real file exists', () => {
    writeFileSync(join(tmpDir, 'README.md'), '', 'utf-8')
    expect(isEmptyProject(tmpDir)).toBe(false)
  })

  it('returns false for a non-existent directory', () => {
    expect(isEmptyProject(join(tmpDir, 'missing'))).toBe(false)
  })
})

describe('renderFullClaudeMd', () => {
  it('renders an 8-section CLAUDE.md with governance sections', () => {
    const out = renderFullClaudeMd('my-app')
    expect(out).toContain('一、项目概述')
    expect(out).toContain('二、AI 编码协作原则')
    expect(out).toContain('三、合规与安全')
    expect(out).toContain('八、代码评审检查清单')
    expect(out).toContain('修订历史')
    expect(out).toContain('Conventional Commits')
  })
})

describe('renderLicenseMd', () => {
  it('renders MIT license', () => {
    expect(renderLicenseMd('mit')).toContain('MIT License')
  })
  it('renders Apache 2.0 license', () => {
    expect(renderLicenseMd('apache')).toContain('Apache License 2.0')
  })
  it('renders Proprietary license', () => {
    const out = renderLicenseMd('proprietary')
    expect(out).toContain('Proprietary Software')
    expect(out).toContain('All rights reserved')
  })
})

describe('renderContributingMd', () => {
  it('uses closed-source wording for proprietary', () => {
    const out = renderContributingMd('my-app', 'proprietary')
    expect(out).toContain('专有闭源商业软件')
    expect(out).not.toContain('开源许可')
  })
  it('uses open-source wording for mit', () => {
    const out = renderContributingMd('my-app', 'mit')
    expect(out).toContain('MIT')
    expect(out).toContain('开源许可')
  })
})

describe('scaffoldProject --full', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mipham-full-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const fullFiles = [
    'CLAUDE.md',
    'MIPHAM.md',
    'README.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'DEVELOPMENT.md',
    'TRADEMARKS.md',
    'CHANGELOG.md',
    'LICENSE',
    '.github/pull_request_template.md',
    '.github/CODEOWNERS',
  ]

  it('creates the complete .md set + .github templates', () => {
    const projectDir = join(tmpDir, 'proj')
    const result = scaffoldProject(projectDir, { full: true })

    for (const f of fullFiles) {
      expect(result.created).toContain(f)
    }
    expect(existsSync(join(projectDir, '.github/ISSUE_TEMPLATE/bug_report.md'))).toBe(true)
    expect(existsSync(join(projectDir, '.github/ISSUE_TEMPLATE/feature_request.md'))).toBe(true)
  })

  it('uses the 8-section CLAUDE.md for --full', () => {
    const projectDir = join(tmpDir, 'proj')
    scaffoldProject(projectDir, { full: true })
    expect(readFileSync(join(projectDir, 'CLAUDE.md'), 'utf-8')).toContain('八、代码评审检查清单')
  })

  it('writes MIT LICENSE and open-source CONTRIBUTING for --license=mit', () => {
    const projectDir = join(tmpDir, 'proj')
    scaffoldProject(projectDir, { full: true, license: 'mit' })
    expect(readFileSync(join(projectDir, 'LICENSE'), 'utf-8')).toContain('MIT License')
    expect(readFileSync(join(projectDir, 'CONTRIBUTING.md'), 'utf-8')).toContain('开源许可')
  })

  it('defaults to proprietary LICENSE for --full without --license', () => {
    const projectDir = join(tmpDir, 'proj')
    scaffoldProject(projectDir, { full: true })
    expect(readFileSync(join(projectDir, 'LICENSE'), 'utf-8')).toContain('Proprietary Software')
  })
})
