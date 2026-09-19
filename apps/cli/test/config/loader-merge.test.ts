import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate from the real ~/.mipham — loadConfig() reads (and may create) config.yml there.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-config-merge`,
  }
})

import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from '../../src/config/loader'

const MIPHAM_HOME = join(homedir(), '.mipham')
const CWD = join(homedir(), 'proj')

function writeProjectConfig(yaml: string): void {
  mkdirSync(join(CWD, '.mipham'), { recursive: true })
  writeFileSync(join(CWD, '.mipham', 'config.yml'), yaml, 'utf-8')
}

function writeUserConfig(yaml: string): void {
  mkdirSync(MIPHAM_HOME, { recursive: true })
  writeFileSync(join(MIPHAM_HOME, 'config.yml'), yaml, 'utf-8')
}

describe('loadConfig — object-valued keys merge across sources', () => {
  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
  })

  it('keeps sibling keys of a two-level object (features.mcp vs features.context)', () => {
    // project sets one branch, user sets the other — a shallow merge lets the
    // user-level `features` replace the whole object and drop `context`.
    writeProjectConfig('features:\n  context:\n    adaptiveThresholds: false\n')
    writeUserConfig('features:\n  mcp:\n    oauthEnabled: false\n')

    const config = loadConfig(CWD)

    expect(config.features?.context?.adaptiveThresholds).toBe(false)
    expect(config.features?.mcp?.oauthEnabled).toBe(false)
  })

  it('keeps sibling keys of crsi flags', () => {
    // Both read as `!== false`, so a dropped key silently reverts to the default (on).
    writeProjectConfig('crsi:\n  preToolHook: false\n')
    writeUserConfig('crsi:\n  ruleInjection: false\n')

    const config = loadConfig(CWD)

    expect(config.crsi?.preToolHook).toBe(false)
    expect(config.crsi?.ruleInjection).toBe(false)
  })

  it('keeps skills.paths when another source sets only skills.reminder', () => {
    writeProjectConfig('skills:\n  paths:\n    - /proj/skills\n')
    writeUserConfig('skills:\n  reminder: "off"\n')

    const config = loadConfig(CWD)

    expect(config.skills?.paths).toEqual(['/proj/skills'])
    expect(config.skills?.reminder).toBe('off')
  })

  it('keeps permissionRules.deny when another source sets only permissionRules.allow', () => {
    writeProjectConfig('permissionRules:\n  deny:\n    - "Read(**/.npmrc)"\n')
    writeUserConfig('permissionRules:\n  allow:\n    - "Bash(git status)"\n')

    const config = loadConfig(CWD)

    expect(config.permissionRules?.deny).toEqual(['Read(**/.npmrc)'])
    expect(config.permissionRules?.allow).toEqual(['Bash(git status)'])
  })

  it('replaces arrays rather than concatenating them across sources', () => {
    // Guard: an override must not append to the other source's list.
    writeProjectConfig('skills:\n  paths:\n    - /proj/skills\n')
    writeUserConfig('skills:\n  paths:\n    - /user/skills\n')

    const config = loadConfig(CWD)

    expect(config.skills?.paths).toEqual(['/user/skills'])
  })

  it('still lets a scalar in the higher-precedence source win', () => {
    writeProjectConfig('defaultModel: project-model\n')
    writeUserConfig('defaultModel: user-model\n')

    expect(loadConfig(CWD).defaultModel).toBe('user-model')
  })
})

describe('loadConfig — .mcp.json keeps the full server shape', () => {
  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
    mkdirSync(CWD, { recursive: true })
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
  })

  it('carries request_timeout_ms and auth through from .mcp.json', () => {
    writeFileSync(
      join(CWD, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          forge: {
            url: 'https://forge.example/mcp',
            request_timeout_ms: 12345,
            auth: {
              type: 'oauth',
              authorizationUrl: 'https://forge.example/oauth/authorize',
              tokenUrl: 'https://forge.example/oauth/token',
              clientId: 'mipham-cli',
              scopes: ['mcp'],
            },
          },
        },
      }),
      'utf-8',
    )

    const server = loadConfig(CWD).skills?.mcpServers.find((s) => s.name === 'forge')

    expect(server).toBeDefined()
    expect(server?.request_timeout_ms).toBe(12345)
    expect(server?.auth?.clientId).toBe('mipham-cli')
    expect(server?.auth?.scopes).toEqual(['mcp'])
  })
})
