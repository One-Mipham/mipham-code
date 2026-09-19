import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginManager } from '../../src/plugin/plugin-manager'

const childProcessMock = vi.hoisted(() => ({ execFileSync: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: childProcessMock.execFileSync }
})

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
    testPluginDir = join(
      TEST_HOME,
      'plugins-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    )
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
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'no-version' }), 'utf-8')
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

// ============================================================
// installFromNpm — 从 npm 装插件时的脚本执行面
//
// 装一个包 = 让它的 postinstall/preinstall 以当前用户全权跑一遍。
// 对「装插件」这个动作来说那是我们不想要的副作用：插件本身只需
// 要是磁盘上的一份文件。本组把 argv 形状钉住，防它再被改回去。
// ============================================================

describe('PluginManager — state.json 的形状与原子写', () => {
  let dir: string

  beforeEach(() => {
    dir = join(TEST_HOME, 'state-' + Math.random().toString(36).slice(2, 8))
    mkdirSync(dir, { recursive: true })
  })

  it('state.json 是合法 JSON 但不是数组时启动为空列表，而不是抛', () => {
    // `{}` / `null` / `"x"` 都能被 JSON.parse 接受，`loadState` 原先直接把它当
    // `InstalledPlugin[]` 收下 ⇒ 之后任何 `.find`/`.filter` 都抛，整条插件命令
    // 挂掉。判据取「构造 + 读取不抛且为空」，不是「文件被删掉」。
    for (const bad of ['{}', 'null', '"x"', '123']) {
      writeFileSync(join(dir, 'state.json'), bad, 'utf-8')
      const m = new PluginManager(dir)
      expect(m.list()).toEqual([])
      expect(m.getEnabled()).toEqual([])
    }
  })

  it('合法数组仍然照常加载（正控：上面的判据不是恒真的）', () => {
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify([
        {
          name: 'kept',
          version: '1.0.0',
          path: '/tmp/kept',
          enabled: true,
          installedAt: new Date().toISOString(),
        },
      ]),
      'utf-8',
    )

    expect(new PluginManager(dir).list().map((p) => p.name)).toEqual(['kept'])
  })

  it('写入是原子的（换 inode），且不留临时文件', () => {
    const m = new PluginManager(dir)
    m.install(createTempPlugin('first'))
    const statePath = join(dir, 'state.json')
    expect(existsSync(statePath)).toBe(true)

    // 裸 writeFileSync 是原地截断重写 ⇒ inode 不变；先写同目录临时文件再 rename
    // 才换 inode。权限与「无 .tmp 残骸」都证明不了这一点。
    const before = statSync(statePath).ino
    m.install(createTempPlugin('second'))
    expect(
      m
        .list()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['first', 'second']) // 正控：内容真变了
    expect(statSync(statePath).ino).not.toBe(before)
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])
  })
})

describe('installFromNpm 的安装命令', () => {
  let npmPluginDir: string

  beforeEach(() => {
    npmPluginDir = join(
      TEST_HOME,
      'npm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    )
    mkdirSync(npmPluginDir, { recursive: true })
    childProcessMock.execFileSync.mockReset()
    // 让被装的包在 npm 装完之后真的「存在」：按 --prefix 造出
    // node_modules/<pkg>/plugin.json，装完的校验步骤才能走通。
    childProcessMock.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const prefix = args[args.indexOf('--prefix') + 1]!
      const pkgDir = join(prefix, 'node_modules', args[1]!)
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(
        join(pkgDir, 'plugin.json'),
        JSON.stringify({ name: 'npm-plugin', version: '2.0.0' }),
        'utf-8',
      )
      return ''
    })
  })

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true })
  })

  it('不给被装包执行 postinstall 的机会（--ignore-scripts）', () => {
    new PluginManager(npmPluginDir).installFromNpm('npm-plugin')
    const args = childProcessMock.execFileSync.mock.calls[0]![1] as string[]
    expect(args).toContain('--ignore-scripts')
  })

  it('经 execFileSync 以 argv 数组调用，不经 shell 拼接', () => {
    new PluginManager(npmPluginDir).installFromNpm('npm-plugin')
    const [cmd, args] = childProcessMock.execFileSync.mock.calls[0]! as [string, string[]]
    expect(cmd).toBe('npm')
    expect(Array.isArray(args)).toBe(true)
    expect(args).toContain('--no-save')
    expect(args).toContain('--prefix')
  })

  it('仍然把包装进插件目录并登记（修复未破坏安装流程）', () => {
    const result = new PluginManager(npmPluginDir).installFromNpm('npm-plugin')
    expect(result.success).toBe(true)
    expect(result.message).toContain('npm-plugin')
  })

  it('拒绝非法包名时根本不调用 npm', () => {
    const result = new PluginManager(npmPluginDir).installFromNpm('evil; rm -rf /')
    expect(result.success).toBe(false)
    expect(childProcessMock.execFileSync).not.toHaveBeenCalled()
  })
})
