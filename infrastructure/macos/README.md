# Mipham Code — macOS App

Native macOS application for Mipham Code.

## Build

```bash
# Version is read from apps/cli/package.json automatically.
# 1. Build the .app bundle
./create-app.sh

# 2. Package as DMG
./create-dmg.sh

# Output: mipham-code-<version>.dmg
```

## Install

### Direct Download

1. Download `mipham-code-0.21.0.dmg` from [mipham.ai/dl](https://mipham.ai/dl)
2. Open the DMG, drag "Mipham Code" to Applications
3. Double-click to launch

### Homebrew

```bash
brew install --cask mipham
```

## Requirements

- macOS 12 (Monterey) or later
- [Mipham Code CLI](https://mipham.ai/code) installed (`mipham` on PATH)

## Code Signing (optional)

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
./create-dmg.sh
```

Requires an Apple Developer account and a stored notary keychain profile:

```bash
xcrun notarytool store-credentials "mipham-notary" \
    --apple-id "your@email.com" \
    --team-id "TEAMID" \
    --password "@keychain:AC_PASSWORD"
```
