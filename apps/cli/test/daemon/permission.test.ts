import { describe, it, expect, afterEach } from 'vitest'
import { buildDaemonPermission } from '../../src/daemon/server'

const ENV_KEY = 'MIPHAM_DAEMON_PERMISSION'

afterEach(() => {
  delete process.env[ENV_KEY]
})

describe('buildDaemonPermission', () => {
  it('defaults to least-privilege default when env is unset', () => {
    delete process.env[ENV_KEY]
    expect(buildDaemonPermission().getMode()).toBe('default')
  })

  it('downgrades bypassPermissions when forbidden by restrictions', () => {
    process.env[ENV_KEY] = 'bypassPermissions'
    const ps = buildDaemonPermission({ forbiddenModes: ['bypassPermissions'] })
    expect(ps.getMode()).toBe('dontAsk') // clamped to highest allowed
  })

  it('honors env mode when restrictions allow it', () => {
    process.env[ENV_KEY] = 'auto'
    const ps = buildDaemonPermission({ forbiddenModes: ['bypassPermissions'] })
    expect(ps.getMode()).toBe('auto')
  })
})
