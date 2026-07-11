import { execSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function takeScreenshot(): Promise<{
  success: boolean
  data?: string
  error?: string
}> {
  const tmpPath = join(tmpdir(), `mipham-screenshot-${Date.now()}.png`)

  try {
    const platform = process.platform
    if (platform === 'darwin') {
      execSync(`screencapture -x ${tmpPath}`, { timeout: 10000 })
    } else if (platform === 'linux') {
      execSync(`import -window root ${tmpPath}`, { timeout: 10000 })
    } else if (platform === 'win32') {
      // PowerShell script to capture primary screen and save as PNG
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bitmap = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Bounds.X, $screen.Bounds.Y, 0, 0, $bitmap.Size)
$bitmap.Save('${tmpPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
      `.trim()
      const psPath = join(tmpdir(), `mipham-sc-${Date.now()}.ps1`)
      writeFileSync(psPath, psScript, 'utf-8')
      execSync(`powershell -ExecutionPolicy Bypass -File "${psPath}"`, { timeout: 15000 })
      try {
        unlinkSync(psPath)
      } catch {
        // ignore cleanup failures
      }
    }

    const data = readFileSync(tmpPath, 'base64')
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore cleanup failures
    }
    return { success: true, data: `data:image/png;base64,${data}` }
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore cleanup failures
    }
    return { success: false, error: `Screenshot failed: ${String(err)}` }
  }
}
