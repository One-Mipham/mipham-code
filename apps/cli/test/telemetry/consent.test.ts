import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-tel-consent` }
})

import { tmpdir, hostname, userInfo } from 'node:os'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { settingsPathFor } from '../../src/config/loader'
import {
  isHardDisabled,
  resolveTelemetry,
  readTelemetrySettings,
  getOrCreateInstallId,
  resetInstallId,
  setTelemetryEnabled,
  wasPrompted,
  markPrompted,
  isInteractive,
  telemetryDir,
} from '../../src/telemetry/consent'
import { OFFICIAL_TELEMETRY_ENDPOINT, NO_ENDPOINT } from '../../src/telemetry/endpoint'

const HOME = `${tmpdir()}/mipham-test-tel-consent`
const PROJECT = `${tmpdir()}/mipham-test-tel-project`
const USER_SETTINGS = join(HOME, '.mipham', 'settings.json')
const PROJECT_SETTINGS = join(PROJECT, '.mipham', 'settings.json')

function writeSettings(path: string, doc: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
}

function reset(): void {
  for (const dir of [HOME, PROJECT]) {
    rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(PROJECT, { recursive: true })
}

/** No env var set — the common case. */
const NO_ENV: NodeJS.ProcessEnv = {}

describe('consent — hard kill switch', () => {
  it('recognises only the exact value off', () => {
    expect(isHardDisabled({ MIPHAM_TELEMETRY: 'off' })).toBe(true)
    expect(isHardDisabled({ MIPHAM_TELEMETRY: '1' })).toBe(false)
    expect(isHardDisabled({ MIPHAM_TELEMETRY: 'OFF' })).toBe(false)
    expect(isHardDisabled(NO_ENV)).toBe(false)
  })

  it('overrides even explicit user consent', () => {
    reset()
    writeSettings(USER_SETTINGS, { telemetry: { enabled: true } })
    const consent = resolveTelemetry(PROJECT, { MIPHAM_TELEMETRY: 'off' })
    // Literally nothing: not the user's endpoint, not the shipped default. The
    // switch is resolved before a destination is ever looked at.
    expect(consent).toEqual({
      enabled: false,
      endpoint: '',
      source: 'env-off',
      endpointSource: 'off',
    })
  })
})

describe('consent — three tiers', () => {
  beforeEach(reset)
  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true })
    rmSync(PROJECT, { recursive: true, force: true })
  })

  it('is off by default, before anyone is asked', () => {
    expect(resolveTelemetry(PROJECT, NO_ENV).source).toBe('default-off')
    expect(resolveTelemetry(PROJECT, NO_ENV).enabled).toBe(false)
  })

  it('honours user opt-in', () => {
    writeSettings(USER_SETTINGS, { telemetry: { enabled: true } })
    const consent = resolveTelemetry(PROJECT, NO_ENV)
    expect(consent.enabled).toBe(true)
    expect(consent.source).toBe('user-optin')
  })

  it('lets a project veto, even against user opt-in', () => {
    writeSettings(USER_SETTINGS, { telemetry: { enabled: true } })
    writeSettings(PROJECT_SETTINGS, { telemetry: { enabled: false } })
    const consent = resolveTelemetry(PROJECT, NO_ENV)
    expect(consent.enabled).toBe(false)
    expect(consent.source).toBe('project-veto')
  })

  it('does NOT let a project grant consent', () => {
    // Otherwise cloning a repository would be the repository consenting for you.
    writeSettings(PROJECT_SETTINGS, { telemetry: { enabled: true } })
    expect(resolveTelemetry(PROJECT, NO_ENV).enabled).toBe(false)
    expect(resolveTelemetry(PROJECT, NO_ENV).source).toBe('default-off')
  })

  it('reads the endpoint from user settings, with the env var taking precedence', () => {
    writeSettings(USER_SETTINGS, { telemetry: { enabled: true, endpoint: 'https://a.example/x' } })
    expect(resolveTelemetry(PROJECT, NO_ENV).endpoint).toBe('https://a.example/x')
    expect(
      resolveTelemetry(PROJECT, { MIPHAM_TELEMETRY_ENDPOINT: 'https://b.example/x' }).endpoint,
    ).toBe('https://b.example/x')
  })

  it('defaults the endpoint to the official receiver, and names the default as its source', () => {
    const consent = resolveTelemetry(PROJECT, NO_ENV)
    expect(consent.endpoint).toBe(OFFICIAL_TELEMETRY_ENDPOINT)
    expect(consent.endpointSource).toBe('default')
  })

  it('reports which tier supplied the destination', () => {
    writeSettings(USER_SETTINGS, { telemetry: { enabled: true, endpoint: 'https://a.example/x' } })
    expect(resolveTelemetry(PROJECT, NO_ENV).endpointSource).toBe('user')
    expect(
      resolveTelemetry(PROJECT, { MIPHAM_TELEMETRY_ENDPOINT: 'https://b.example/x' })
        .endpointSource,
    ).toBe('env')
  })

  it('honours the none sentinel: still opted in, but sending nowhere', () => {
    writeSettings(USER_SETTINGS, { telemetry: { enabled: true, endpoint: NO_ENDPOINT } })
    const consent = resolveTelemetry(PROJECT, NO_ENV)
    expect(consent.enabled).toBe(true)
    expect(consent.endpoint).toBe('')
    expect(consent.endpointSource).toBe('user')

    // An empty override is *not* the same thing — being falsy, it falls through
    // to the shipped default and the machine starts sending. The sentinel is
    // the only way to say "nowhere", which is the whole reason it exists.
    writeSettings(USER_SETTINGS, { telemetry: { enabled: true, endpoint: '' } })
    expect(resolveTelemetry(PROJECT, NO_ENV).endpoint).toBe(OFFICIAL_TELEMETRY_ENDPOINT)
  })

  it('fails closed on a malformed settings.json instead of throwing', () => {
    mkdirSync(join(HOME, '.mipham'), { recursive: true })
    writeFileSync(USER_SETTINGS, '{ this is not json')
    expect(readTelemetrySettings('user', PROJECT)).toEqual({})
    expect(resolveTelemetry(PROJECT, NO_ENV).enabled).toBe(false)
  })

  it('ignores a telemetry block of the wrong shape', () => {
    writeSettings(USER_SETTINGS, { telemetry: 'yes please' })
    expect(resolveTelemetry(PROJECT, NO_ENV).enabled).toBe(false)
    writeSettings(USER_SETTINGS, { telemetry: [1, 2] })
    expect(resolveTelemetry(PROJECT, NO_ENV).enabled).toBe(false)
  })
})

describe('consent — writes preserve what we do not model', () => {
  beforeEach(reset)
  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true })
    rmSync(PROJECT, { recursive: true, force: true })
  })

  it('leaves hooks, permissions and unknown keys untouched', () => {
    // This is the whole reason the switch lives in settings.json rather than
    // config.yml — config.yml merges shallowly and would drop these.
    writeSettings(USER_SETTINGS, {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
      permissions: { allow: ['Read'], deny: [] },
      somethingFromAFutureVersion: { keep: 'me' },
    })

    setTelemetryEnabled(true, PROJECT)

    const doc = JSON.parse(readFileSync(USER_SETTINGS, 'utf-8'))
    expect(doc.hooks).toEqual({ PreToolUse: [{ matcher: 'Bash', hooks: [] }] })
    expect(doc.permissions).toEqual({ allow: ['Read'], deny: [] })
    expect(doc.somethingFromAFutureVersion).toEqual({ keep: 'me' })
    expect(doc.telemetry.enabled).toBe(true)
  })

  it('persists into the user scope, not the project scope', () => {
    setTelemetryEnabled(true, PROJECT)
    expect(existsSync(USER_SETTINGS)).toBe(true)
    expect(settingsPathFor('user', PROJECT)).toBe(USER_SETTINGS)
    expect(existsSync(PROJECT_SETTINGS)).toBe(false)
  })
})

describe('consent — anonymous install id', () => {
  beforeEach(reset)
  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true })
    rmSync(PROJECT, { recursive: true, force: true })
  })

  it('is a bare uuid and is stable across reads', () => {
    const first = getOrCreateInstallId(PROJECT)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(getOrCreateInstallId(PROJECT)).toBe(first)
  })

  it('is a bare random uuid — not derived from host or user', () => {
    const id = getOrCreateInstallId(PROJECT)
    expect(id).not.toContain(hostname())
    expect(id).not.toContain(userInfo().username)
  })

  it('can be reset', () => {
    const before = getOrCreateInstallId(PROJECT)
    const after = resetInstallId(PROJECT)
    expect(after).not.toBe(before)
    expect(getOrCreateInstallId(PROJECT)).toBe(after)
  })
})

describe('consent — one-shot prompt marker', () => {
  beforeEach(reset)
  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true })
    rmSync(PROJECT, { recursive: true, force: true })
  })

  it('records that the question was asked', () => {
    expect(wasPrompted(PROJECT)).toBe(false)
    markPrompted(PROJECT, new Date('2026-09-15T00:00:00.000Z'))
    expect(wasPrompted(PROJECT)).toBe(true)
    expect(readTelemetrySettings('user', PROJECT).promptedAt).toBe('2026-09-15T00:00:00.000Z')
  })

  it('is tracked separately from the answer', () => {
    // "asked and declined" must not look like "never asked", or the prompt
    // would reappear on every launch.
    markPrompted(PROJECT)
    expect(wasPrompted(PROJECT)).toBe(true)
    expect(readTelemetrySettings('user', PROJECT).enabled).toBeUndefined()
  })
})

describe('consent — interactivity', () => {
  it('never prompts on CI, without a TTY, or in non-interactive mode', () => {
    expect(isInteractive({ CI: 'true' }, true)).toBe(false)
    expect(isInteractive({}, undefined)).toBe(false)
    expect(isInteractive({ MIPHAM_NON_INTERACTIVE: '1' }, true)).toBe(false)
  })

  it('prompts on a plain TTY', () => {
    expect(isInteractive({}, true)).toBe(true)
  })
})

describe('consent — queue location', () => {
  it('sits under the mocked homedir, never the real ~/.mipham', () => {
    expect(telemetryDir()).toBe(join(HOME, '.mipham', 'telemetry'))
    const real = process.env.HOME
    if (real) expect(telemetryDir().startsWith(real)).toBe(false)
  })
})
