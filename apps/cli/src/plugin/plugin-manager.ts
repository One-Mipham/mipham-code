import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'
import { validatePlugin } from './plugin-validator'

const PLUGIN_DIR = join(homedir(), '.mipham', 'plugins')

export interface InstalledPlugin {
  name: string
  version: string
  path: string
  enabled: boolean
  installedAt: string
}

export class PluginManager {
  private plugins: InstalledPlugin[] = []
  private pluginDir: string
  private statePath: string

  constructor(pluginDir?: string) {
    this.pluginDir = pluginDir ?? PLUGIN_DIR
    mkdirSync(this.pluginDir, { recursive: true })
    this.statePath = join(this.pluginDir, 'state.json')
    this.loadState()
  }

  install(sourcePath: string): { success: boolean; message: string } {
    const validation = validatePlugin(sourcePath)
    if (!validation.valid || !validation.manifest) {
      return { success: false, message: validation.errors.join('; ') }
    }

    const destDir = join(this.pluginDir, validation.manifest.name)
    if (existsSync(destDir)) {
      return {
        success: false,
        message: `Plugin "${validation.manifest.name}" is already installed`,
      }
    }

    // Copy plugin directory
    mkdirSync(destDir, { recursive: true })
    this.copyDir(sourcePath, destDir)

    this.plugins.push({
      name: validation.manifest.name,
      version: validation.manifest.version,
      path: destDir,
      enabled: true,
      installedAt: new Date().toISOString(),
    })

    this.saveState()
    return {
      success: true,
      message: `Plugin "${validation.manifest.name}" v${validation.manifest.version} installed`,
    }
  }

  /** Validate npm package name against the npm spec. */
  private isValidPackageName(name: string): boolean {
    // npm package name regex: optional @scope/ + package name
    return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)
  }

  /**
   * Install a plugin from npm (e.g. `npm install <package>` into the plugins dir).
   * The npm package must export a valid plugin manifest at its root.
   */
  installFromNpm(packageName: string): { success: boolean; message: string } {
    if (!this.isValidPackageName(packageName)) {
      return { success: false, message: `Invalid package name: "${packageName}"` }
    }

    // Derive plugin name from npm package name (strip scope prefix)
    const pluginName = packageName.replace(/^@.+\//, '').replace(/^mipham-plugin-/, '')

    const destDir = join(this.pluginDir, pluginName)
    if (existsSync(destDir)) {
      return {
        success: false,
        message: `Plugin "${pluginName}" is already installed`,
      }
    }

    try {
      // Install the npm package into the plugins directory
      mkdirSync(destDir, { recursive: true })

      // Create a minimal package.json so npm install works in a subdirectory
      writeFileSync(
        join(destDir, 'package.json'),
        JSON.stringify({ private: true }, null, 2),
        'utf-8',
      )

      execSync(`npm install ${packageName} --prefix "${destDir}" --no-save`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 60_000,
      })

      // Validate the installed plugin
      const validation = validatePlugin(destDir)
      if (!validation.valid) {
        // Clean up on invalid plugin
        rmSync(destDir, { recursive: true, force: true })
        return { success: false, message: validation.errors.join('; ') }
      }

      this.plugins.push({
        name: validation.manifest?.name || pluginName,
        version: validation.manifest?.version || '0.0.0',
        path: destDir,
        enabled: true,
        installedAt: new Date().toISOString(),
      })

      this.saveState()
      return {
        success: true,
        message: `Plugin "${pluginName}" installed from npm`,
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // Clean up on failure
      try { rmSync(destDir, { recursive: true, force: true }) } catch { /* ok */ }
      return { success: false, message: `npm install failed: ${msg}` }
    }
  }

  list(): InstalledPlugin[] {
    return [...this.plugins]
  }

  remove(name: string): boolean {
    const plugin = this.plugins.find((p) => p.name === name)
    if (!plugin) return false
    try {
      rmSync(plugin.path, { recursive: true, force: true })
    } catch {
      // Directory may already be gone — that's fine
    }
    this.plugins = this.plugins.filter((p) => p.name !== name)
    this.saveState()
    return true
  }

  enable(name: string): boolean {
    const p = this.plugins.find((p) => p.name === name)
    if (!p) return false
    p.enabled = true
    this.saveState()
    return true
  }

  disable(name: string): boolean {
    const p = this.plugins.find((p) => p.name === name)
    if (!p) return false
    p.enabled = false
    this.saveState()
    return true
  }

  getEnabled(): InstalledPlugin[] {
    return this.plugins.filter((p) => p.enabled)
  }

  private copyDir(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name)
      const destPath = join(dest, entry.name)
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath)
      } else {
        const content = readFileSync(srcPath)
        writeFileSync(destPath, content)
      }
    }
  }

  private loadState(): void {
    try {
      if (existsSync(this.statePath)) {
        this.plugins = JSON.parse(readFileSync(this.statePath, 'utf-8'))
      }
    } catch {
      this.plugins = []
    }
  }

  private saveState(): void {
    writeFileSync(this.statePath, JSON.stringify(this.plugins, null, 2), 'utf-8')
  }
}
