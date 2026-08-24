import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
} from 'node:fs'
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
  private cleanupCallbacks = new Map<string, () => void>()

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

    const similarWarning = this.findSimilarWarning(validation.manifest.name)
    this.plugins.push({
      name: validation.manifest.name,
      version: validation.manifest.version || '0.0.0',
      path: destDir,
      enabled: true,
      installedAt: new Date().toISOString(),
    })

    this.saveState()
    return {
      success: true,
      message:
        `Plugin "${validation.manifest.name}" v${validation.manifest.version} installed` +
        (similarWarning ? `\n⚠ ${similarWarning}` : ''),
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

    // Staging dir name derived from the npm package name (scope stripped). The
    // final directory is renamed to the manifest `name` once validated — the two
    // can differ (e.g. a scoped package whose manifest declares a shorter name).
    const stagingName = packageName.replace(/^@.+\//, '').replace(/^mipham-plugin-/, '')

    const stagingDir = join(this.pluginDir, stagingName)
    if (existsSync(stagingDir)) {
      return {
        success: false,
        message: `Plugin "${stagingName}" is already installed`,
      }
    }

    try {
      // Install the npm package into the plugins directory
      mkdirSync(stagingDir, { recursive: true })

      // Create a minimal package.json so npm install works in a subdirectory
      writeFileSync(
        join(stagingDir, 'package.json'),
        JSON.stringify({ private: true }, null, 2),
        'utf-8',
      )

      execSync(`npm install ${packageName} --prefix "${stagingDir}" --no-save`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 60_000,
      })

      // npm installs the package into <stagingDir>/node_modules/<packageName>/ —
      // validate there, then flatten it to the plugin dir root so its layout
      // matches `install(sourcePath)`.
      const pkgDir = join(stagingDir, 'node_modules', packageName)
      const validation = validatePlugin(pkgDir)
      if (!validation.valid) {
        // Clean up on invalid plugin
        rmSync(stagingDir, { recursive: true, force: true })
        return { success: false, message: validation.errors.join('; ') }
      }

      this.copyDir(pkgDir, stagingDir)
      rmSync(join(stagingDir, 'node_modules'), { recursive: true, force: true })

      // Use the manifest `name` for the final directory + record + message so
      // they all agree (npm package name is only the staging key).
      const manifestName = validation.manifest?.name || stagingName
      let destDir = stagingDir
      if (manifestName !== stagingName) {
        destDir = join(this.pluginDir, manifestName)
        if (existsSync(destDir)) {
          rmSync(stagingDir, { recursive: true, force: true })
          return { success: false, message: `Plugin "${manifestName}" is already installed` }
        }
        renameSync(stagingDir, destDir)
      }

      this.plugins.push({
        name: manifestName,
        version: validation.manifest?.version || '0.0.0',
        path: destDir,
        enabled: true,
        installedAt: new Date().toISOString(),
      })

      this.saveState()
      const similarWarning = this.findSimilarWarning(manifestName)
      return {
        success: true,
        message:
          `Plugin "${manifestName}" installed from npm` +
          (similarWarning ? `\n⚠ ${similarWarning}` : ''),
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // Clean up on failure
      try {
        rmSync(stagingDir, { recursive: true, force: true })
      } catch {
        /* ok */
      }
      return { success: false, message: `npm install failed: ${msg}` }
    }
  }

  list(): InstalledPlugin[] {
    return [...this.plugins]
  }

  /**
   * Check if the new plugin name is similar to any existing installed plugin.
   * Warns about potential name squatting / confusion.
   * Returns a warning string or empty string.
   */
  private findSimilarWarning(newName: string): string {
    const existing = this.plugins.map((p) => p.name)
    const similar = existing.filter((name) => this.areNamesSimilar(newName, name))
    if (similar.length === 0) return ''
    return `Similar plugin${similar.length > 1 ? 's' : ''} already installed: ${similar.join(', ')}. Verify you trust this source.`
  }

  /**
   * Two names are "similar" if:
   * - One is a prefix of the other (e.g. "auth" vs "auth-pro")
   * - They differ by ≤ 2 characters (Levenshtein distance)
   */
  private areNamesSimilar(a: string, b: string): boolean {
    if (a === b) return false // exact match is handled by "already installed" check
    if (a.startsWith(b) || b.startsWith(a)) return true

    // Simple edit-distance approximation: count differing chars
    const maxLen = Math.max(a.length, b.length)
    let diffs = 0
    for (let i = 0; i < maxLen; i++) {
      if (a[i] !== b[i]) diffs++
      if (diffs > 2) return false
    }
    return diffs <= 2
  }

  /**
   * Register a cleanup callback that will be invoked when the named plugin is removed.
   * This allows the plugin loader to tear down hooks, agents, MCP connections, and tools.
   */
  onRemove(name: string, cleanup: () => void): void {
    this.cleanupCallbacks.set(name, cleanup)
  }

  remove(name: string): boolean {
    const plugin = this.plugins.find((p) => p.name === name)
    if (!plugin) return false

    // Run registered cleanup: disconnect MCP, unregister hooks/agents/tools
    const cleanup = this.cleanupCallbacks.get(name)
    if (cleanup) {
      try {
        cleanup()
      } catch {
        /* cleanup is best-effort */
      }
      this.cleanupCallbacks.delete(name)
    }

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
