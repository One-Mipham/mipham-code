#!/usr/bin/env bash
#
# Mipham Code — 遥测接收端：装 Node 22 到 /opt
#
#   sudo bash install-node.sh
#   sudo NODE_VERSION=22.24.0 bash install-node.sh    # 升版本
#
# **为什么不用 apt 源，也不用 nvm。**
#   · apt 源（NodeSource）会把一个第三方仓库钉进 `/etc/apt/sources.list.d/`，
#     从此每次 `apt upgrade` 都会顺带升级运行时 —— 生产机上「谁改的、什么时候改的」
#     就没有答案了。本服务是常驻进程，运行时版本变化必须是一次**显式的、可回滚的动作**。
#   · nvm 是给交互式 shell 用的，systemd 看不到它。
# 官方 tarball 解到 /opt 两者都避开了：版本号在路径里（可并存、可回滚成改一个软链），
# 校验和可核对，`apt` 完全不知情。
#
# 校验的**诚实边界**：SHASUMS256.txt 与 tarball 来自同一个源、同一条 TLS 连接。
# 它挡得住传输损坏与镜像不同步，**挡不住** nodejs.org 本身被换掉。要挡住后者得上
# GPG 签名（`SHASUMS256.txt.sig` + 发布密钥环）—— 那需要多带一份密钥材料并接受
# 密钥轮换，本项的量级不值得。这里写明边界，而不是让 `sha256sum -c` 看起来像更多。

set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.23.2}"
ARCH="${ARCH:-linux-x64}"
DIST_URL="https://nodejs.org/dist"
PREFIX="/opt"
DIRNAME="node-v${NODE_VERSION}-${ARCH}"
DEST="${PREFIX}/${DIRNAME}"
LINK="${PREFIX}/node"

die() {
  printf 'install-node: %s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "must run as root (try: sudo bash $0)"
[ "$(uname -s)" = "Linux" ] || die "this script targets Linux; got $(uname -s)"
[ "$(uname -m)" = "x86_64" ] || die "ARCH=${ARCH} assumes x86_64; got $(uname -m)"

command -v curl >/dev/null 2>&1 || die "curl not found"
command -v tar >/dev/null 2>&1 || die "tar not found"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found (coreutils)"
# `-J` 需要 xz。Ubuntu 24.04 自带；缺了要说清楚，而不是让 tar 抛一句 "xz: not found"。
tar --help 2>&1 | grep -q -- '-J' || die "tar lacks xz support (install xz-utils)"

if [ -x "${DEST}/bin/node" ]; then
  printf 'install-node: %s already present (%s)\n' "${DEST}" "$("${DEST}/bin/node" --version)"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "${TMP}"' EXIT

  TARBALL="${DIRNAME}.tar.xz"
  printf 'install-node: downloading %s\n' "${TARBALL}"
  curl -fsSL --retry 3 --proto '=https' -o "${TMP}/${TARBALL}" \
    "${DIST_URL}/v${NODE_VERSION}/${TARBALL}"
  curl -fsSL --retry 3 --proto '=https' -o "${TMP}/SHASUMS256.txt" \
    "${DIST_URL}/v${NODE_VERSION}/SHASUMS256.txt"

  # 先证明「校验和在文件里」，再校验。少了这一步，`sha256sum -c -` 吃到一个空输入
  # 会**成功退出**——于是所有下载都「通过校验」，包括被篡改的那些。
  CHECKSUM_LINE="$(grep "  ${TARBALL}\$" "${TMP}/SHASUMS256.txt")" \
    || die "SHASUMS256.txt has no entry for ${TARBALL} — wrong version, or the manifest moved"
  printf '%s\n' "${CHECKSUM_LINE}" | (cd "${TMP}" && sha256sum -c -) \
    || die "checksum mismatch for ${TARBALL} — refusing to install"

  printf 'install-node: extracting to %s\n' "${DEST}"
  mkdir -p "${DEST}"
  # 解到临时目录再改名：中途失败不会留下一个「存在但不完整」的 DEST，
  # 否则上面那条 `[ -x ]` 幂等判断会在下一次运行时放行一个残缺的安装。
  tar -xJf "${TMP}/${TARBALL}" -C "${DEST}" --strip-components=1
fi

[ -x "${DEST}/bin/node" ] || die "extraction produced no ${DEST}/bin/node"

# `--version` 必须逐字对上。校验和已经保证了字节，这一条保证的是**路径与版本一致**
# —— `ARCH` 或 `NODE_VERSION` 被手滑改错时，这是唯一会喊出来的地方。
ACTUAL="$("${DEST}/bin/node" --version)"
[ "${ACTUAL}" = "v${NODE_VERSION}" ] \
  || die "expected v${NODE_VERSION}, got ${ACTUAL} — refusing to point ${LINK} at it"

# 稳定软链：systemd unit 里写的是 /opt/node/bin/node，升版本时不必改 unit。
ln -sfn "${DEST}" "${LINK}"

# 给人用的 PATH（systemd 不看这个，它走 unit 里的绝对路径）。
PROFILE="/etc/profile.d/node.sh"
printf 'export PATH="%s/bin:$PATH"\n' "${LINK}" > "${PROFILE}"
chmod 0644 "${PROFILE}"

printf 'install-node: %s -> %s\n' "${LINK}" "${ACTUAL}"
printf 'install-node: done. New shells get node on PATH; systemd uses %s/bin/node directly.\n' "${LINK}"
