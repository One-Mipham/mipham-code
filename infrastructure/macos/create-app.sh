#!/bin/bash
# infrastructure/macos/create-app.sh
# Build Mipham Code.app bundle from CLI assets.
#
# Usage: ./create-app.sh [version]
#   version defaults to 0.21.0
#
# Output: infrastructure/macos/Mipham Code.app/

set -euo pipefail

VERSION="${1:-0.21.0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$SCRIPT_DIR/Mipham Code.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

echo "==> Building Mipham Code.app v$VERSION"

# Clean previous build
rm -rf "$APP_DIR"

# Create directory structure
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES"

# --- Info.plist ---
cat > "$CONTENTS/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>MiphamCode</string>
    <key>CFBundleIconFile</key>
    <string>icon</string>
    <key>CFBundleIdentifier</key>
    <string>ai.mipham.code</string>
    <key>CFBundleName</key>
    <string>Mipham Code</string>
    <key>CFBundleDisplayName</key>
    <string>Mipham Code</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>LSBackgroundOnly</key>
    <false/>
    <key>LSUIElement</key>
    <false/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# --- Executable ---
cat > "$MACOS_DIR/MiphamCode" << 'SCRIPT'
#!/bin/bash
# Mipham Code launcher — opens Terminal and runs mipham

if command -v mipham &>/dev/null; then
    # Use AppleScript to open Terminal and run mipham
    osascript -e '
        tell application "Terminal"
            activate
            do script "mipham; exit"
        end tell'
else
    # Mipham not installed — show install dialog
    INSTALL_CMD='curl -fsSL https://mipham.ai/install.sh | bash'
    RESPONSE=$(osascript -e "
        display dialog \"Mipham Code is not installed.\\n\\nTo install, run this command in Terminal:\\n$INSTALL_CMD\" \
            with title \"Mipham Code\" \
            buttons {\"Copy Command\", \"OK\"} \
            default button \"OK\"" 2>/dev/null)

    if [[ "$RESPONSE" == *"Copy Command"* ]]; then
        echo -n "$INSTALL_CMD" | pbcopy
        osascript -e '
            display dialog "Install command copied to clipboard.\n\nPaste it in Terminal and press Enter." \
                with title "Mipham Code" \
                buttons {"OK"} \
                default button "OK"'
    fi
fi
SCRIPT

chmod +x "$MACOS_DIR/MiphamCode"

# --- Icon ---
ICON_SRC="$REPO_ROOT/apps/cli/assets/icon.icns"
if [ -f "$ICON_SRC" ]; then
    cp "$ICON_SRC" "$RESOURCES/icon.icns"
    echo "   Icon: copied from apps/cli/assets/icon.icns"
else
    echo "   WARNING: icon.icns not found at $ICON_SRC"
fi

echo "==> Done: $APP_DIR"
echo "   Version: $VERSION"
echo "   Bundle ID: ai.mipham.code"
