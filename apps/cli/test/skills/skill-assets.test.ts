import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureSkillAssets } from '../../src/skills/skill-assets'
import type { BundledSkillAsset } from '../../src/skills/bundled-skill-assets'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skill-assets-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const fakeAssets: Record<string, BundledSkillAsset[]> = {
  'web-access': [
    { path: 'scripts/cdp-proxy.mjs', content: '#!/usr/bin/env node\nconsole.log("proxy")' },
    { path: 'references/cdp-api.md', content: '# CDP API' },
  ],
}

describe('ensureSkillAssets', () => {
  it('returns null for a skill with no bundled assets', () => {
    expect(ensureSkillAssets('unknown', { baseDir: tmp, assets: fakeAssets })).toBeNull()
  })

  it('extracts assets on first call (mkdir recursive)', () => {
    const root = ensureSkillAssets('web-access', { baseDir: tmp, assets: fakeAssets })
    expect(root).toBe(join(tmp, 'web-access'))
    expect(readFileSync(join(root!, 'scripts', 'cdp-proxy.mjs'), 'utf-8')).toBe(
      fakeAssets['web-access']![0]!.content,
    )
    expect(readFileSync(join(root!, 'references', 'cdp-api.md'), 'utf-8')).toBe(
      fakeAssets['web-access']![1]!.content,
    )
  })

  it('restores drifted content on next call (content compare)', () => {
    const root = ensureSkillAssets('web-access', { baseDir: tmp, assets: fakeAssets })!
    const dest = join(root, 'scripts', 'cdp-proxy.mjs')
    const original = readFileSync(dest, 'utf-8')
    writeFileSync(dest, 'CORRUPTED')
    ensureSkillAssets('web-access', { baseDir: tmp, assets: fakeAssets })
    expect(readFileSync(dest, 'utf-8')).toBe(original)
    expect(existsSync(join(root, 'references', 'cdp-api.md'))).toBe(true)
  })
})
