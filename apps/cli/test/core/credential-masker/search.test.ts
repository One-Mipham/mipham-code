import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { maskSearchOutput, maskGlobOutput } from '../../../src/core/credential-masker/search'
import type { CredentialMaskingConfig } from '../../../src/shared/types'

const config: CredentialMaskingConfig = {
  enabled: true,
  files: [
    { path: '**/.env*', mode: 'full' },
    { path: '**/.aws/credentials', mode: 'full' },
  ],
  output_scrubbing: { enabled: false, patterns: [] },
  env_filter: { enabled: false, patterns: [] },
}

describe('maskSearchOutput — ripgrep --heading format', () => {
  it('masks match lines under a sensitive file heading', () => {
    const out = maskSearchOutput(
      '/home/user/project/.env\n1:API_KEY=sk-123\n2:DB_PASS=hunter2\n/home/user/project/app.ts\n10:const x = 1\n',
      config,
      'heading',
    )
    expect(out).toContain('1:__MIPHAM_CREDENTIAL_MASKED__')
    expect(out).toContain('2:__MIPHAM_CREDENTIAL_MASKED__')
    expect(out).toContain('10:const x = 1')
    expect(out).not.toContain('sk-123')
    expect(out).not.toContain('hunter2')
  })

  it('leaves non-sensitive files unmasked', () => {
    const out = maskSearchOutput('/home/user/app.ts\n1:hello\n', config, 'heading')
    expect(out).toBe('/home/user/app.ts\n1:hello\n')
  })

  it('passes through when disabled', () => {
    const out = maskSearchOutput(
      '/home/user/.env\n1:secret\n',
      { ...config, enabled: false },
      'heading',
    )
    expect(out).toContain('secret')
  })
})

describe('maskSearchOutput — grep -rn format', () => {
  it('masks sensitive-file lines', () => {
    const out = maskSearchOutput(
      '/home/user/project/.env:1:API_KEY=sk-123\n/home/user/app.ts:5:hello\n',
      config,
      'filename',
    )
    expect(out).toContain('/home/user/project/.env:1:__MIPHAM_CREDENTIAL_MASKED__')
    expect(out).toContain('/home/user/app.ts:5:hello')
    expect(out).not.toContain('sk-123')
  })
})

describe('maskGlobOutput', () => {
  it('masks sensitive file paths but keeps the rest', () => {
    const out = maskGlobOutput('/home/user/.env\n/home/user/app.ts\n', config)
    expect(out).toContain('__MIPHAM_CREDENTIAL_MASKED__')
    expect(out).toContain('/home/user/app.ts')
    expect(out).not.toContain('/home/user/.env')
  })

  it('passes through when disabled', () => {
    const out = maskGlobOutput('/home/user/.env\n', { ...config, enabled: false })
    expect(out).toContain('/home/user/.env')
  })
})

describe('maskSearchOutput / maskGlobOutput — symlink-resolved matching', () => {
  it('masks a symlink whose target matches a deny rule (filename format)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mipham-mask-'))
    try {
      const sensitive = join(tmp, '.env')
      writeFileSync(sensitive, 'SECRET')
      const link = join(tmp, 'harmless.txt')
      symlinkSync(sensitive, link)

      const out = maskSearchOutput(`${link}:1:leak-me\n`, config, 'filename')
      expect(out).not.toContain('leak-me')
      expect(out).toContain('__MIPHAM_CREDENTIAL_MASKED__')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('masks a symlink whose target matches a deny rule (heading format)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mipham-mask-'))
    try {
      const sensitive = join(tmp, '.env')
      writeFileSync(sensitive, 'SECRET')
      const link = join(tmp, 'harmless.txt')
      symlinkSync(sensitive, link)

      const out = maskSearchOutput(`${link}\n1:leak-me\n`, config, 'heading')
      expect(out).not.toContain('leak-me')
      expect(out).toContain('__MIPHAM_CREDENTIAL_MASKED__')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('masks a symlink whose target matches a deny rule (glob format)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mipham-mask-'))
    try {
      const sensitive = join(tmp, '.env')
      writeFileSync(sensitive, 'SECRET')
      const link = join(tmp, 'harmless.txt')
      symlinkSync(sensitive, link)

      const out = maskGlobOutput(`${link}\n${join(tmp, 'app.ts')}\n`, config)
      expect(out).toContain('__MIPHAM_CREDENTIAL_MASKED__')
      expect(out).toContain('app.ts')
      expect(out).not.toContain('harmless.txt')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
