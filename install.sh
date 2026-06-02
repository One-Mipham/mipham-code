#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Mipham Code — Official Installer
# ============================================================
# One-liner: curl -fsSL https://onemipham.com/install.sh | bash
# ============================================================

BOLD="\033[1m"
CYAN="\033[0;36m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

PACKAGE="@mipham/cli"
BUN_MIN_VERSION="1.2.0"
NODE_MIN_VERSION="22.0.0"

# ── Banner ──
echo ""
echo -e "${CYAN}${BOLD}✦ Mipham Code Installer${RESET}"
echo -e "${CYAN}  Multi-model open-core intelligent coding terminal${RESET}"
echo ""

# ── OS Detection ──
OS="$(uname -s)"
case "$OS" in
  Darwin)  OS_NAME="macOS" ;;
  Linux)   OS_NAME="Linux" ;;
  *)
    echo -e "${RED}✗ Unsupported OS: $OS${RESET}"
    echo "  Mipham Code supports macOS and Linux."
    exit 1
    ;;
esac

echo -e "  Detected: ${GREEN}$OS_NAME${RESET}"

# ── Runtime Detection ──
RUNTIME=""
INSTALL_RUNTIME_CMD=""

# Prefer Bun if available
if command -v bun &>/dev/null; then
  BUN_VERSION="$(bun --version 2>/dev/null | sed 's/^v//')"
  echo -e "  Found:   ${GREEN}Bun v$BUN_VERSION${RESET}"
  RUNTIME="bun"
elif command -v node &>/dev/null; then
  NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
  NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
  if [ "$NODE_MAJOR" -ge 22 ]; then
    echo -e "  Found:   ${GREEN}Node.js v$NODE_VERSION${RESET}"
    RUNTIME="node"
  else
    echo -e "  ${YELLOW}⚠ Node.js v$NODE_VERSION detected (v22+ recommended)${RESET}"
    echo -e "  ${YELLOW}  Installing Bun for optimal performance...${RESET}"
  fi
else
  echo -e "  ${YELLOW}⚠ No runtime detected${RESET}"
fi

# ── Install Bun if needed ──
if [ -z "$RUNTIME" ]; then
  echo -e "  Installing Bun (fast all-in-one JavaScript runtime)..."
  if command -v curl &>/dev/null; then
    curl -fsSL https://bun.sh/install | bash
  elif command -v wget &>/dev/null; then
    wget -qO- https://bun.sh/install | bash
  else
    echo -e "${RED}✗ Need curl or wget to install Bun.${RESET}"
    echo "  Install manually: https://bun.sh/"
    exit 1
  fi

  # Source bun for current shell
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if command -v bun &>/dev/null; then
    echo -e "  ${GREEN}✓ Bun installed successfully${RESET}"
    RUNTIME="bun"
  else
    echo -e "${RED}✗ Bun installation failed.${RESET}"
    echo "  Install manually: https://bun.sh/"
    exit 1
  fi
fi

# ── Install Mipham Code ──
echo ""
echo -e "  Installing ${BOLD}$PACKAGE${RESET}..."

if [ "$RUNTIME" = "bun" ]; then
  bun install -g "$PACKAGE" 2>&1 || {
    echo -e "${RED}✗ Installation failed.${RESET}"
    echo "  Try: npm install -g $PACKAGE"
    exit 1
  }
else
  npm install -g "$PACKAGE" 2>&1 || {
    echo -e "${RED}✗ Installation failed.${RESET}"
    exit 1
  }
fi

# ── Verify ──
echo ""
if command -v mipham &>/dev/null; then
  VERSION="$(mipham --version 2>/dev/null || echo 'unknown')"
  echo -e "${GREEN}${BOLD}✓ Mipham Code v$VERSION installed successfully!${RESET}"
  echo ""
  echo -e "  Run ${BOLD}mipham${RESET} to start."
  echo -e "  Run ${BOLD}mipham --help${RESET} for options."
  echo ""
else
  echo -e "${YELLOW}⚠ Installation may have succeeded, but 'mipham' not found in PATH.${RESET}"
  echo "  Add to PATH or restart your terminal."
fi
