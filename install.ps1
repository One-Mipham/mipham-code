# ============================================================
# Mipham Code — Windows Installer (PowerShell)
# ============================================================
# International: irm https://mipham.ai/install.ps1 | iex
# China mainland: irm https://onemipham.com/install.ps1 | iex
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "✦ Mipham Code Installer" -ForegroundColor Cyan
Write-Host "  Multi-model open-core intelligent coding terminal" -ForegroundColor Cyan
Write-Host ""

# ── OS Check ──
if ($IsLinux) {
  $OS = "linux"
  Write-Host "✓ Detected: Linux" -ForegroundColor Green
} elseif ($IsMacOS) {
  $OS = "macos"
  Write-Host "✓ Detected: macOS" -ForegroundColor Green
} else {
  $OS = "windows"
  Write-Host "✓ Detected: Windows" -ForegroundColor Green
}

# ── Check Node.js ──
try {
  $nodeVersion = node --version 2>$null
  if ($nodeVersion) {
    Write-Host "✓ Node.js: $nodeVersion" -ForegroundColor Green
    $hasNode = $true
  }
} catch {
  $hasNode = $false
}

# ── Check npm ──
try {
  $npmVersion = npm --version 2>$null
  if ($npmVersion) {
    Write-Host "✓ npm: v$npmVersion" -ForegroundColor Green
    $hasNpm = $true
  }
} catch {
  $hasNpm = $false
}

# ── Check Bun ──
try {
  $bunVersion = bun --version 2>$null
  if ($bunVersion) {
    Write-Host "✓ Bun: v$bunVersion" -ForegroundColor Green
    $hasBun = $true
  }
} catch {
  $hasBun = $false
}

Write-Host ""

# ── Install Method ──
if ($hasNpm) {
  Write-Host "── Installing via npm ──" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Running: npm install -g @onemipham/cli"
  npm install -g @onemipham/cli
} elseif ($hasBun) {
  Write-Host "── Installing via Bun ──" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Running: bun install -g @onemipham/cli"
  bun install -g @onemipham/cli
} else {
  Write-Host "── Prerequisites needed ──" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Mipham Code requires Node.js 22+ or Bun 1.2+."
  Write-Host ""
  Write-Host "Install Node.js (recommended):" -ForegroundColor Green
  Write-Host "  winget install OpenJS.NodeJS.LTS"
  Write-Host "  # or download from https://nodejs.org"
  Write-Host ""
  Write-Host "Then re-run this installer:"
  Write-Host "  irm https://mipham.ai/install.ps1 | iex  (international)" -ForegroundColor Cyan
  Write-Host "  irm https://onemipham.com/install.ps1 | iex  (China mainland)" -ForegroundColor Cyan
  exit 1
}

Write-Host ""
Write-Host "── Installation Complete ──" -ForegroundColor Green
Write-Host ""
Write-Host "Start Mipham Code:" -ForegroundColor Cyan
Write-Host "  mipham" -ForegroundColor White
Write-Host ""
Write-Host "International: https://mipham.ai/code" -ForegroundColor Blue
Write-Host "China mainland: https://onemipham.com/code" -ForegroundColor Blue
Write-Host ""

# ── Verify ──
try {
  mipham --version
} catch {
  Write-Host "⚠  Run 'mipham' in a new terminal window."
}
