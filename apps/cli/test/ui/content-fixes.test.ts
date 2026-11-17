/**
 * Content honesty: stale, misleading, or unimplemented claims in command output.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    throw new Error('git unavailable in this test')
  }),
  execFileSync: vi.fn(() => {
    throw new Error('git unavailable in this test')
  }),
}))

const { mockManifest } = vi.hoisted(() => ({ mockManifest: vi.fn() }))
vi.mock('../../src/artifacts/manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/artifacts/manifest')>()
  return { ...actual, readManifest: mockManifest }
})
vi.mock('../../src/artifacts/paths', () => ({ artifactsRoot: () => '/tmp/artifacts-test' }))

const { getCommand, getCommandList } = (await import('../../src/ui/commands')) as unknown as {
  getCommand: (
    name: string,
  ) =>
    | ((ctx: unknown, args: string[]) => Promise<{ content: string }> | { content: string })
    | undefined
  getCommandList: () => { name: string; description: string }[]
}
const { PACKAGE_VERSION } = (await import('../../src/shared/package-info')) as {
  PACKAGE_VERSION: string
}

const messages = Array.from({ length: 7 }, (_, i) => ({
  role: 'user',
  content: `user-${i + 1} message content`,
}))

const mkCtx = () =>
  ({
    engine: {
      getTools: () => new Map(),
      getContext: () => ({
        getMessages: () => messages,
        getMessageCount: () => messages.length,
        getEstimatedTokens: () => 100,
        getCheckpoints: () => [],
      }),
      getPermission: () => ({ getMode: () => 'default' }),
    },
    config: { providers: [] },
    sessionId: 's',
    t: undefined,
  }) as never

describe('/summary and /recap recent topics', () => {
  it('/summary lists the newest five messages, not the oldest five', async () => {
    const result = await getCommand('/summary')!(mkCtx(), [])
    expect(result.content).toContain('user-7')
    expect(result.content).not.toContain('user-1 message')
  })

  it('/recap lists the newest five messages', async () => {
    const result = await getCommand('/recap')!(mkCtx(), [])
    expect(result.content).toContain('user-7')
    expect(result.content).not.toContain('user-1 message')
  })
})

describe('/crsi meta does not advertise an unimplemented flag', () => {
  it('never mentions --apply', async () => {
    const meta = {
      systemHealth: {
        components: {
          errorSignatures: 0,
          preflightPrevention: 0,
          autoCorrection: 0,
          immuneMemory: 0,
          ruleEffectiveness: 0,
        },
        score: 0,
        assessment: 'n/a',
        recommendations: [],
      },
      metaRules: [],
    }
    const ctx = {
      engine: {
        getMetaRuleEngine: () => ({ analyze: () => meta, getAutoApplicable: () => [] }),
      },
    } as never
    const result = await getCommand('/crsi meta')!(ctx, [])
    expect(result.content).not.toContain('--apply')
  })
})

describe('/security quick scan', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mipham-security-'))
  const prev = process.cwd()
  afterEach(() => process.chdir(prev))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  it('does not report package.json presence as a security pass', async () => {
    writeFileSync(join(tmp, 'package.json'), '{}')
    process.chdir(tmp)
    const result = await getCommand('/security')!({} as never, [])
    expect(result.content).not.toContain('dependencies manageable')
    expect(result.content).not.toContain('TLS')
  })
})

describe('/release-notes reflects the current version', () => {
  it('prints the running version rather than a hardcoded v0.1.2 history', async () => {
    const result = await getCommand('/release-notes')!({} as never, [])
    expect(result.content).not.toContain('v0.1.2')
    expect(result.content).toContain(PACKAGE_VERSION)
  })
})

describe('/setup stale claims', () => {
  const setupCtx = () =>
    ({
      skillsLoader: {
        countByType: () => ({ standard: 1, mipham: 0, total: 1 }),
        getNamesByType: () => ['demo'],
      },
      engine: { getTools: () => new Map([['read', {}]]) },
      config: {},
      t: undefined,
    }) as never

  it('step 4 points at the shipped marketplace instead of "coming soon"', async () => {
    const result = await getCommand('/setup')!(setupCtx(), ['4'])
    expect(result.content).not.toContain('Coming soon')
    expect(result.content).toContain('/browse-skills')
    expect(result.content).toContain('/install-skill')
  })

  it('step 6 does not call the shipped IDE integrations "coming soon"', async () => {
    const result = await getCommand('/setup')!(setupCtx(), ['6'])
    expect(result.content).not.toContain('VS Code     — coming soon')
    expect(result.content).not.toContain('JetBrains   — coming soon')
  })
})

describe('/workflow watch', () => {
  it('reports the state it actually read, not a canned sentence', async () => {
    const result = await getCommand('/workflow watch')!({} as never, [])
    expect(result.content).not.toContain('No active workflow detected')
    // Either it names a live run (bus has one) or it says none is running in
    // this process — both are readings, not guesses.
    expect(result.content).toMatch(/Active run:|No workflow is running in this process/)
  })
})

describe('/artifact server', () => {
  it('reports the manifest port instead of a hardcoded 9876', async () => {
    mockManifest.mockReturnValue({ artifacts: [], port: 9999 })
    const result = await getCommand('/artifact')!({} as never, ['server'])
    expect(result.content).toContain('9999')
    expect(result.content).not.toContain('9876')
  })

  it('says the server is not running when the manifest has no port', async () => {
    mockManifest.mockReturnValue({ artifacts: [] })
    const result = await getCommand('/artifact')!({} as never, ['server'])
    expect(result.content.toLowerCase()).toContain('not running')
  })
})

describe('/effort label', () => {
  it('describes what it actually changes (the stream stall budget)', () => {
    const entry = getCommandList().find((c) => c.name === '/effort')!
    expect(entry.description.toLowerCase()).toMatch(/stall|timeout|idle/)
  })
})

describe('/ide preserves existing editor settings', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mipham-ide-'))
  const prev = process.cwd()
  beforeEach(() => {
    mkdirSync(join(tmp, '.vscode'), { recursive: true })
    writeFileSync(join(tmp, '.vscode', 'settings.json'), JSON.stringify({ 'editor.fontSize': 14 }))
    process.chdir(tmp)
  })
  afterEach(() => {
    process.chdir(prev)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('merges the Mipham profile without clobbering unrelated keys', async () => {
    await getCommand('/ide')!({} as never, [])
    const settings = JSON.parse(readFileSync(join(tmp, '.vscode', 'settings.json'), 'utf-8'))
    expect(settings['editor.fontSize']).toBe(14)
    expect(Object.keys(settings['terminal.integrated.profiles.osx'])).toContain('mipham')
  })
})
