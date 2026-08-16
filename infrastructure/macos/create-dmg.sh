#!/bin/bash
# infrastructure/macos/create-dmg.sh
# Package Mipham Code.app into a .dmg for distribution.
#
# Usage: ./create-dmg.sh [version]
#   version defaults to 0.21.0
#
# Requires: create-app.sh already run (Mipham Code.app exists)
#
# Output: mipham-code-{version}.dmg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-$(node -p "require('$SCRIPT_DIR/../../apps/cli/package.json').version" 2>/dev/null || echo '0.0.0')}"
APP_DIR="$SCRIPT_DIR/Mipham Code.app"
DMG_NAME="mipham-code-${VERSION}.dmg"
DMG_PATH="$SCRIPT_DIR/$DMG_NAME"
VOL_NAME="Mipham Code"

echo "==> Packaging $DMG_NAME"

# Ensure .app exists
if [ ! -d "$APP_DIR" ]; then
    echo "ERROR: $APP_DIR not found. Run create-app.sh first."
    exit 1
fi

# Clean previous DMG
rm -f "$DMG_PATH"

# Create DMG
echo "   Creating disk image..."
hdiutil create \
    -volname "$VOL_NAME" \
    -srcfolder "$APP_DIR" \
    -ov \
    -format UDZO \
    "$DMG_PATH"

echo "==> Done: $DMG_PATH"

# --- Optional: Code sign + Notarize ---
SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

if [ -n "$SIGN_IDENTITY" ]; then
    echo "==> Signing with identity: $SIGN_IDENTITY"

    # Sign the .app
    codesign --force --options runtime \
        --entitlements "$SCRIPT_DIR/entitlements.plist" \
        --sign "$SIGN_IDENTITY" \
        "$APP_DIR"

    echo "   App signed."

    # Submit for notarization
    echo "   Submitting for notarization..."
    xcrun notarytool submit "$DMG_PATH" \
        --keychain-profile "mipham-notary" \
        --wait 2>&1 | tail -3

    # Staple the ticket
    xcrun stapler staple "$DMG_PATH"
    echo "   Notarization ticket stapled."
else
    echo "   (skipping code sign — set APPLE_SIGNING_IDENTITY to enable)"
fi

echo "==> Ready for distribution: $DMG_NAME"
