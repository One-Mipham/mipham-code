import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginManager } from '../../src/plugin/plugin-manager'

const TEST_HOME = join(tmpdir(), 'mipham-plugin-test-' + Date.now())

function createTempPlugin(name: string, hooks?: Record<string, unknown>): string {
  const dir = join(TEST_HOME, 'source', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', hooks }, null, 2),
    'utf-8',
  )
  return dir
}

describe('PluginManager', () => {
  let manager: PluginManager
  let testPluginDir: string

  beforeEach(() => {
    testPluginDir = join(TEST_HOME, 'plugins-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
    mkdirSync(testPluginDir, { recursive: true })
    manager = new PluginManager(testPluginDir)
  })

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true })
  })

  describe('list', () => {
    it('should return empty list when no plugins installed', () => {
      expect(manager.list()).toEqual([])
    })
  })

  describe('install', () => {
    it('should install a valid plugin', () => {
      const source = createTempPlugin('test-plugin')
      const result = manager.install(source)

      expect(result.success).toBe(true)
      expect(result.message).toContain('test-plugin')
      expect(result.message).toContain('1.0.0')

      const plugins = manager.list()
      expect(plugins).toHaveLength(1)
      const p = plugins[0]!
      expect(p.name).toBe('test-plugin')
      expect(p.version).toBe('1.0.0')
      expect(p.enabled).toBe(true)
      expect(p.installedAt).toBeTruthy()
      expect(p.path).toContain('plugins')
      expect(p.path).toContain('test-plugin')
    })

    it('should reject installing a plugin that is already installed', () => {
      const source = createTempPlugin('test-plugin')
      manager.install(source)
      const result = manager.install(source)

      expect(result.success).toBe(false)
      expect(result.message).toContain('already installed')
    })

    it('should reject a plugin with invalid name', () => {
      const source = createTempPlugin('Invalid Name!')
      const result = manager.install(source)

      expect(result.success).toBe(false)
      expect(result.message).toContain('Invalid plugin name')
    })

    it('should reject a plugin without version', () => {
      const dir = join(TEST_HOME, 'source', 'no-version')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'plugin.json'),
        JSON.stringify({ name: 'no-version' }),
        'utf-8',
      )
      const result = manager.install(dir)

      expect(result.success).toBe(false)
      expect(result.message).toContain('Missing required field: version')
    })

    it('should reject a plugin with suspicious hooks', () => {
      const source = createTempPlugin('suspicious-plugin', {
        onStart: 'rm -rf /',
      })
      const result = manager.install(source)

      expect(result.success).toBe(false)
      expect(result.message).toContain('Suspicious hook commands')
    })
  })

  describe('remove', () => {
    it('should remove an installed plugin', () => {
      const source = createTempPlugin('removable-plugin')
      manager.install(source)

      expect(manager.list()).toHaveLength(1)

      const result = manager.remove('removable-plugin')
      expect(result).toBe(true)
      expect(manager.list()).toHaveLength(0)
    })

    it('should return false when removing a non-existent plugin', () => {
      const result = manager.remove('nonexistent')
      expect(result).toBe(false)
    })
  })

  describe('enable/disable', () => {
    it('should disable an enabled plugin', () => {
      const source = createTempPlugin('toggle-plugin')
      manager.install(source)

      const result = manager.disable('toggle-plugin')
      expect(result).toBe(true)

      const plugins1 = manager.list()
      expect(plugins1[0]!.enabled).toBe(false)
    })

    it('should enable a disabled plugin', () => {
      const source = createTempPlugin('toggle-plugin')
      manager.install(source)
      manager.disable('toggle-plugin')

      const result = manager.enable('toggle-plugin')
      expect(result).toBe(true)

      const plugins2 = manager.list()
      expect(plugins2[0]!.enabled).toBe(true)
    })

    it('should return false when enabling non-existent plugin', () => {
      expect(manager.enable('ghost')).toBe(false)
    })

    it('should return false when disabling non-existent plugin', () => {
      expect(manager.disable('ghost')).toBe(false)
    })
  })

  describe('getEnabled', () => {
    it('should return only enabled plugins', () => {
      const source1 = createTempPlugin('alpha')
      const source2 = createTempPlugin('beta')
      manager.install(source1)
      manager.install(source2)
      manager.disable('beta')

      const enabled = manager.getEnabled()
      expect(enabled).toHaveLength(1)
      const ep = enabled[0]!
      expect(ep.name).toBe('alpha')
    })
  })

  describe('state persistence', () => {
    it('should persist state across PluginManager instances', () => {
      const source = createTempPlugin('persistent-plugin')
      manager.install(source)

      // Create a new manager instance with the same plugin dir — it should load from state.json
      const manager2 = new PluginManager(testPluginDir)
      const plugins3 = manager2.list()

      expect(plugins3).toHaveLength(1)
      expect(plugins3[0]!.name).toBe('persistent-plugin')
      expect(plugins3[0]!.enabled).toBe(true)
    })

    it('should persist disable state', () => {
      const source = createTempPlugin('persistent-plugin')
      manager.install(source)
      manager.disable('persistent-plugin')

      const manager2 = new PluginManager(testPluginDir)
      const plugins4 = manager2.list()

      expect(plugins4).toHaveLength(1)
      expect(plugins4[0]!.enabled).toBe(false)
    })
  })
})
