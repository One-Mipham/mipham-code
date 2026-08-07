#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Mipham Code — Official Installer
# ============================================================
# International: curl -fsSL https://mipham.ai/install.sh | bash
# China mainland: curl -fsSL https://onemipham.com/install.sh | bash
# ============================================================

BOLD="\033[1m"
CYAN="\033[0;36m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

# ⚠️ 包名与 packages/shared/src/package-info.ts 保持同步
#    修改包名时请同时更新: packages/shared/src/package-info.ts + packages/shared/package-info.json
PACKAGE="@miphamai/cli"
BUN_MIN_VERSION="1.2.0"
NODE_MIN_VERSION="22.0.0"

# ── i18n ──
detect_lang() {
  case "${LANG:-}" in
    zh_CN*|zh_CN.*|zh_SG*|zh_*)
      LANG_ID="zh-CN"
      ;;
    *)
      LANG_ID="en-US"
      ;;
  esac
}

detect_lang

# Message functions — each emits text in the detected language.
# Callers do NOT add extra echo; the function handles output directly.

msg_banner_title() {
  echo -e "${CYAN}${BOLD}✦ Mipham Code Installer${RESET}"
}

msg_banner_subtitle() {
  case "$LANG_ID" in
    "zh-CN") echo -e "${CYAN}  多模型开源智能编程终端${RESET}" ;;
    *)       echo -e "${CYAN}  Multi-model open-core intelligent coding terminal${RESET}" ;;
  esac
}

msg_banner() {
  echo ""
  msg_banner_title
  msg_banner_subtitle
  echo ""
}

msg_unsupported_os() {
  local os="$1"
  case "$LANG_ID" in
    "zh-CN")
      echo -e "${RED}✗ 不支持的操作系统: $os${RESET}"
      echo "  Mipham Code 支持 macOS 和 Linux。"
      ;;
    *)
      echo -e "${RED}✗ Unsupported OS: $os${RESET}"
      echo "  Mipham Code supports macOS and Linux."
      ;;
  esac
}

msg_detected() {
  local os="$1"
  case "$LANG_ID" in
    "zh-CN") echo -e "  检测到: ${GREEN}$os${RESET}" ;;
    *)       echo -e "  Detected: ${GREEN}$os${RESET}" ;;
  esac
}

msg_install_options_title() {
  case "$LANG_ID" in
    "zh-CN") echo -e "  ${BOLD}安装选项:${RESET}" ;;
    *)       echo -e "  ${BOLD}Install options:${RESET}" ;;
  esac
}

msg_install_npm_desc() {
  case "$LANG_ID" in
    "zh-CN") echo -e "    • npm install -g @miphamai/cli  (推荐，全平台)" ;;
    *)       echo -e "    • npm install -g @miphamai/cli  (recommended, all platforms)" ;;
  esac
}

msg_install_curl_intl() {
  case "$LANG_ID" in
    "zh-CN") echo -e "    • curl -fsSL https://mipham.ai/install.sh | bash  (国际站)" ;;
    *)       echo -e "    • curl -fsSL https://mipham.ai/install.sh | bash  (international)" ;;
  esac
}

msg_install_curl_cn() {
  case "$LANG_ID" in
    "zh-CN") echo -e "    • curl -fsSL https://onemipham.com/install.sh | bash  (中国大陆)" ;;
    *)       echo -e "    • curl -fsSL https://onemipham.com/install.sh | bash  (China mainland)" ;;
  esac
}

msg_install_direct() {
  case "$LANG_ID" in
    "zh-CN") echo -e "    • 直接下载: https://mipham.ai/code/install" ;;
    *)       echo -e "    • Direct download: https://mipham.ai/code/install" ;;
  esac
}

msg_install_options() {
  echo ""
  msg_install_options_title
  msg_install_npm_desc
  msg_install_curl_intl
  msg_install_curl_cn
  msg_install_direct
  echo ""
}

msg_found_bun() {
  local ver="$1"
  case "$LANG_ID" in
    "zh-CN") echo -e "  发现:   ${GREEN}Bun v$ver${RESET}" ;;
    *)       echo -e "  Found:   ${GREEN}Bun v$ver${RESET}" ;;
  esac
}

msg_found_node() {
  local ver="$1"
  case "$LANG_ID" in
    "zh-CN") echo -e "  发现:   ${GREEN}Node.js v$ver${RESET}" ;;
    *)       echo -e "  Found:   ${GREEN}Node.js v$ver${RESET}" ;;
  esac
}

msg_node_old_warning() {
  local ver="$1"
  case "$LANG_ID" in
    "zh-CN")
      echo -e "  ${YELLOW}⚠ 检测到 Node.js v$ver（推荐 v22+）${RESET}"
      echo -e "  ${YELLOW}  正在安装 Bun 以获得最佳性能...${RESET}"
      ;;
    *)
      echo -e "  ${YELLOW}⚠ Node.js v$ver detected (v22+ recommended)${RESET}"
      echo -e "  ${YELLOW}  Installing Bun for optimal performance...${RESET}"
      ;;
  esac
}

msg_no_runtime() {
  case "$LANG_ID" in
    "zh-CN") echo -e "  ${YELLOW}⚠ 未检测到运行时${RESET}" ;;
    *)       echo -e "  ${YELLOW}⚠ No runtime detected${RESET}" ;;
  esac
}

msg_installing_bun() {
  case "$LANG_ID" in
    "zh-CN") echo -e "  正在安装 Bun（快速全栈 JavaScript 运行时）..." ;;
    *)       echo -e "  Installing Bun (fast all-in-one JavaScript runtime)..." ;;
  esac
}

msg_need_curl_or_wget() {
  case "$LANG_ID" in
    "zh-CN")
      echo -e "${RED}✗ 需要 curl 或 wget 才能安装 Bun。${RESET}"
      echo "  请手动安装: https://bun.sh/"
      ;;
    *)
      echo -e "${RED}✗ Need curl or wget to install Bun.${RESET}"
      echo "  Install manually: https://bun.sh/"
      ;;
  esac
}

msg_bun_installed() {
  case "$LANG_ID" in
    "zh-CN") echo -e "  ${GREEN}✓ Bun 安装成功${RESET}" ;;
    *)       echo -e "  ${GREEN}✓ Bun installed successfully${RESET}" ;;
  esac
}

msg_bun_install_failed() {
  case "$LANG_ID" in
    "zh-CN")
      echo -e "${RED}✗ Bun 安装失败。${RESET}"
      echo "  请手动安装: https://bun.sh/"
      ;;
    *)
      echo -e "${RED}✗ Bun installation failed.${RESET}"
      echo "  Install manually: https://bun.sh/"
      ;;
  esac
}

msg_downloading_binary() {
  local name="$1"
  case "$LANG_ID" in
    "zh-CN") echo -e "  正在下载二进制文件: ${BOLD}$name${RESET}..." ;;
    *)       echo -e "  Downloading binary: ${BOLD}$name${RESET}..." ;;
  esac
}

msg_binary_installed() {
  case "$LANG_ID" in
    "zh-CN") echo -e "  ${GREEN}✓ 二进制文件已安装至 /usr/local/bin/mipham${RESET}" ;;
    *)       echo -e "  ${GREEN}✓ Binary installed to /usr/local/bin/mipham${RESET}" ;;
  esac
}

msg_binary_fallback() {
  case "$LANG_ID" in
    "zh-CN") echo -e "  ${YELLOW}⚠ 二进制下载失败，回退到 npm 安装...${RESET}" ;;
    *)       echo -e "  ${YELLOW}⚠ Binary download failed, falling back to npm...${RESET}" ;;
  esac
}

msg_installing_package() {
  local pkg="$1"
  case "$LANG_ID" in
    "zh-CN") echo -e "  正在安装 ${BOLD}$pkg${RESET}..." ;;
    *)       echo -e "  Installing ${BOLD}$pkg${RESET}..." ;;
  esac
}

msg_install_failed() {
  case "$LANG_ID" in
    "zh-CN") echo -e "${RED}✗ 安装失败。${RESET}" ;;
    *)       echo -e "${RED}✗ Installation failed.${RESET}" ;;
  esac
}

msg_try_npm() {
  local pkg="$1"
  case "$LANG_ID" in
    "zh-CN") echo "  请尝试: npm install -g $pkg" ;;
    *)       echo "  Try: npm install -g $pkg" ;;
  esac
}

msg_install_success() {
  local ver="$1"
  case "$LANG_ID" in
    "zh-CN") echo -e "${GREEN}${BOLD}✓ Mipham Code v$ver 安装成功！${RESET}" ;;
    *)       echo -e "${GREEN}${BOLD}✓ Mipham Code v$ver installed successfully!${RESET}" ;;
  esac
}

msg_post_install() {
  case "$LANG_ID" in
    "zh-CN")
      echo ""
      echo -e "  运行 ${BOLD}mipham${RESET} 启动。"
      echo -e "  运行 ${BOLD}mipham --help${RESET} 查看选项。"
      echo -e "  文档: ${CYAN}https://mipham.ai/code/docs${RESET}"
      echo ""
      ;;
    *)
      echo ""
      echo -e "  Run ${BOLD}mipham${RESET} to start."
      echo -e "  Run ${BOLD}mipham --help${RESET} for options."
      echo -e "  Docs: ${CYAN}https://mipham.ai/code/docs${RESET}"
      echo ""
      ;;
  esac
}

msg_not_in_path() {
  case "$LANG_ID" in
    "zh-CN")
      echo -e "${YELLOW}⚠ 安装可能已成功，但在 PATH 中未找到 'mipham'。${RESET}"
      echo "  请将 mipham 添加到 PATH 或重启终端。"
      ;;
    *)
      echo -e "${YELLOW}⚠ Installation may have succeeded, but 'mipham' not found in PATH.${RESET}"
      echo "  Add to PATH or restart your terminal."
      ;;
  esac
}

# ── Banner ──
msg_banner

# ── OS Detection ──
OS="$(uname -s)"
case "$OS" in
  Darwin)  OS_NAME="macOS" ;;
  Linux)   OS_NAME="Linux" ;;
  *)
    msg_unsupported_os "$OS"
    exit 1
    ;;
esac

msg_detected "$OS_NAME"
msg_install_options

# ── Runtime Detection ──
RUNTIME=""
INSTALL_RUNTIME_CMD=""

# Prefer Bun if available
if command -v bun &>/dev/null; then
  BUN_VERSION="$(bun --version 2>/dev/null | sed 's/^v//')"
  msg_found_bun "$BUN_VERSION"
  RUNTIME="bun"
elif command -v node &>/dev/null; then
  NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
  NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
  if [ "$NODE_MAJOR" -ge 22 ]; then
    msg_found_node "$NODE_VERSION"
    RUNTIME="node"
  else
    msg_node_old_warning "$NODE_VERSION"
  fi
else
  msg_no_runtime
fi

# ── Install Bun if needed ──
if [ -z "$RUNTIME" ]; then
  msg_installing_bun
  if command -v curl &>/dev/null; then
    curl -fsSL https://bun.sh/install | bash
  elif command -v wget &>/dev/null; then
    wget -qO- https://bun.sh/install | bash
  else
    msg_need_curl_or_wget
    exit 1
  fi

  # Source bun for current shell
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if command -v bun &>/dev/null; then
    msg_bun_installed
    RUNTIME="bun"
  else
    msg_bun_install_failed
    exit 1
  fi
fi

# ── Install Mipham Code ──
echo ""

# Try direct binary download first (fastest, no dependencies)
RELEASE_URL="https://github.com/One-Mipham/mipham-code/releases/latest/download"
BINARY_NAME=""
case "$OS" in
  Darwin)
    ARCH="$(uname -m)"
    if [ "$ARCH" = "arm64" ]; then
      BINARY_NAME="mipham-darwin-arm64"
    else
      BINARY_NAME="mipham-darwin-x64"
    fi
    ;;
  Linux)
    BINARY_NAME="mipham-linux-x64"
    ;;
esac

if [ -n "$BINARY_NAME" ]; then
  msg_downloading_binary "$BINARY_NAME"
  BINARY_URL="$RELEASE_URL/$BINARY_NAME"
  if command -v curl &>/dev/null; then
    curl -fsSL "$BINARY_URL" -o /tmp/mipham 2>/dev/null && chmod +x /tmp/mipham && mv /tmp/mipham /usr/local/bin/mipham 2>/dev/null && {
      msg_binary_installed
      RUNTIME="binary"
    } || msg_binary_fallback
  fi
fi

if [ "$RUNTIME" != "binary" ]; then
  msg_installing_package "$PACKAGE"

if [ "$RUNTIME" = "bun" ]; then
  bun install -g "$PACKAGE" 2>&1 || {
    msg_install_failed
    msg_try_npm "$PACKAGE"
    exit 1
  }
else
  npm install -g "$PACKAGE" 2>&1 || {
    msg_install_failed
    exit 1
  }
fi
fi

# ── Verify ──
echo ""
if command -v mipham &>/dev/null; then
  VERSION="$(mipham --version 2>/dev/null || echo 'unknown')"
  msg_install_success "$VERSION"
  msg_post_install
else
  msg_not_in_path
fi
