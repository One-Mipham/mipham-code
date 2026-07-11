import { execSync } from 'node:child_process'

const ALLOWED_APPS = new Set([
  'Finder',
  'Safari',
  'Google Chrome',
  'Firefox',
  'Terminal',
  'VS Code',
  'System Settings',
  'Activity Monitor',
  'TextEdit',
  'Preview',
])

export function launchApp(appName: string): { success: boolean; message: string } {
  if (!ALLOWED_APPS.has(appName)) {
    return {
      success: false,
      message: `App "${appName}" is not in the allowed list. Allowed: ${[...ALLOWED_APPS].join(', ')}`,
    }
  }

  try {
    const platform = process.platform
    if (platform === 'darwin') {
      execSync(`open -a "${appName}"`, { timeout: 5000 })
    } else if (platform === 'linux') {
      execSync(`xdg-open "${appName}"`, { timeout: 5000 })
    } else if (platform === 'win32') {
      execSync(`start "" "${appName}"`, { timeout: 5000, shell: 'cmd.exe' })
    } else {
      return { success: false, message: `Unsupported platform: ${platform}` }
    }
    return { success: true, message: `Launched: ${appName}` }
  } catch (err) {
    return { success: false, message: `Failed to launch ${appName}: ${String(err)}` }
  }
}
