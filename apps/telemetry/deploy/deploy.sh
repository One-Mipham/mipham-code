#!/usr/bin/env bash
#
# Mipham Code — 遥测接收端部署
#
#   sudo bash deploy.sh install            # 铺 vhost + unit，建用户/目录，reload nginx
#   sudo bash deploy.sh --check            # 与线上逐字 diff，有漂移非零退出
#   sudo bash deploy.sh install --acme     # 只铺「80 端口 ACME 块」，签发证书前的第一步
#   sudo bash deploy.sh keys init          # 生成聚合加密密钥（绝不可重复执行）
#
# **本脚本在主机上运行**，从一份已同步的仓库副本（默认 /opt/mipham-telemetry）。
# `--check` 的参照物是**这份副本**：先把仓库同步上去、再在主机上 diff，
# 才能发现「有人手改过 /etc/nginx」。若脚本自己带着资产、又自己解包到 /etc，
# 那 diff 就变成了拿刚写下的内容比对它自己 —— 恒绿，等于没有检查。
#
# 应用本体（dist/）不归本脚本管：它由开发机 `pnpm --filter @mipham/telemetry build`
# 产出后 rsync 上来（命令见 deploy/README.md）。本脚本只**校验它在那儿**，
# 因为「配置铺好了但程序不在」的失败发生在 systemd 启动时，日志比这里难读。

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- 路径常量 -----------------------------------------------------------
APP_ROOT="${APP_ROOT:-/opt/mipham-telemetry}"
SERVICE_USER="mipham-telemetry"
UNIT_NAME="mipham-telemetry.service"
VHOST_NAME="log.onemipham.com"
VHOST_CONF="${VHOST_NAME}.conf"
NGINX_AVAILABLE="/etc/nginx/sites-available/${VHOST_CONF}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${VHOST_CONF}"
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}"
ETC_DIR="/etc/mipham-telemetry"
KEY_PATH="${ETC_DIR}/aggregate.key"
ENV_PATH="${ETC_DIR}/telemetry.env"
DATA_DIR="/var/lib/mipham-telemetry"
NODE_BIN="/opt/node/bin/node"

SRC_VHOST="${SELF_DIR}/nginx/${VHOST_CONF}"
SRC_UNIT="${SELF_DIR}/systemd/${UNIT_NAME}"

log() { printf 'deploy: %s\n' "$*"; }
die() {
  printf 'deploy: %s\n' "$1" >&2
  exit 1
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "must run as root (try: sudo bash $0 $*)"
}
require_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found"
}
require_nginx() {
  command -v nginx >/dev/null 2>&1 || die "nginx not found"
}

# ---------------------------------------------------------------------------
# 用户与目录
# ---------------------------------------------------------------------------
ensure_user() {
  if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    return 0
  fi
  log "creating system user ${SERVICE_USER}"
  useradd --system --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "${SERVICE_USER}"
}

ensure_dirs() {
  # 数据目录归服务用户：`.lock` 与每日聚合文件都由它创建。
  install -d -m 0700 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${DATA_DIR}"
  # 配置目录**不归**服务用户 —— 它只读密钥，不写这里。
  # 但需要 +x 才能走到密钥文件：故 root:${SERVICE_USER} 0750。
  # （plan 里写的 0700/0400 假定服务以 root 跑；实际是 User=${SERVICE_USER}，
  #  那样写服务读不到密钥、且失败发生在启动时而非部署时。）
  install -d -m 0750 -o root -g "${SERVICE_USER}" "${ETC_DIR}"
}

write_env_file() {
  if [ -f "${ENV_PATH}" ]; then
    log "${ENV_PATH} exists — left alone"
    return 0
  fi
  # 变量名与默认值都是 src/config.ts 里 env.MIPHAM_TELEMETRY_* 的逐字对应。
  # 全部写出来（而非只写想覆盖的那几个）：运维打开这份文件就能看到完整可调面，
  # 不必再回去读源码。密钥**不在这里** —— 只有它的路径。
  umask 077
  cat > "${ENV_PATH}" <<EOF
# Mipham Code telemetry collector — 见 apps/telemetry/src/config.ts
MIPHAM_TELEMETRY_HOST=127.0.0.1
MIPHAM_TELEMETRY_PORT=9099
MIPHAM_TELEMETRY_DATA_DIR=${DATA_DIR}
MIPHAM_TELEMETRY_KEY_PATH=${KEY_PATH}
MIPHAM_TELEMETRY_CANONICAL_HOST=log.onemipham.com
MIPHAM_TELEMETRY_FLUSH_EVERY=25
MIPHAM_TELEMETRY_FLUSH_INTERVAL_MS=10000
EOF
  chown root:root "${ENV_PATH}"
  chmod 0600 "${ENV_PATH}"
  log "wrote ${ENV_PATH}"
}

# ---------------------------------------------------------------------------
# vhost
# ---------------------------------------------------------------------------
# 把已发布的 vhost **派生**出「只剩第一个 server 块」的 ACME 引导版。
# 派生而非另写一份：两份手写的 80 块迟早会漂移，而漂移的那一份正是
# 「80 端口到底回 444 还是 301」这条安全属性的载体。
generate_acme_bootstrap() {
  awk '
    /^server \{/ { n++ }
    n > 1 { exit }
    { print }
  ' "${SRC_VHOST}"
}

install_vhost() {
  local mode="$1" tmp
  [ -f "${SRC_VHOST}" ] || die "missing ${SRC_VHOST} — is this the repo's deploy/ tree?"

  tmp="$(mktemp)"
  if [ "${mode}" = "acme" ]; then
    {
      printf '# 由 deploy.sh 从 %s 派生 —— 只含 80 端口 ACME 块。\n' "${VHOST_CONF}"
      printf '# 这是**临时**引导文件：certbot 签发完成后由 `deploy.sh install` 整体替换。\n'
      printf '# 不要手改；改源头那份，它才是真源。\n'
      generate_acme_bootstrap
    } > "${tmp}"
  else
    cat "${SRC_VHOST}" > "${tmp}"
  fi

  install -m 0644 -o root -g root "${tmp}" "${NGINX_AVAILABLE}"
  rm -f "${tmp}"
  ln -sfn "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
  log "installed ${NGINX_AVAILABLE} (mode: ${mode})"
}

# nginx -t 失败时**必须回滚软链**：本机 80/443 上还跑着 api 与 quant，
# 一个语法错的 sites-enabled 文件会让 `systemctl reload nginx` 之后
# 所有站一起 502 —— 而失败点离我们这一份文件很远，排查会绕远路。
reload_nginx_or_rollback() {
  local previous="$1"
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    log "nginx reloaded"
    return 0
  fi
  printf 'deploy: nginx -t FAILED — rolling back\n' >&2
  nginx -t || true
  rm -f "${NGINX_ENABLED}"
  [ -n "${previous}" ] && ln -sfn "${previous}" "${NGINX_ENABLED}"
  die "refused to reload nginx with a config it cannot parse (other vhosts untouched)"
}

# ---------------------------------------------------------------------------
# systemd
# ---------------------------------------------------------------------------
install_unit() {
  [ -f "${SRC_UNIT}" ] || die "missing ${SRC_UNIT}"
  install -m 0644 -o root -g root "${SRC_UNIT}" "${UNIT_PATH}"
  systemctl daemon-reload
  log "installed ${UNIT_PATH}"
}

check_app_tree() {
  [ -x "${NODE_BIN}" ] || die "no node at ${NODE_BIN} — run: sudo bash install-node.sh"
  [ -f "${APP_ROOT}/dist/server.js" ] || die "no ${APP_ROOT}/dist/server.js — build locally and rsync (see deploy/README.md)"
}

# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------
cmd_install() {
  local mode="full" previous=""
  [ "${1:-}" = "--acme" ] && mode="acme"

  require_root
  require_nginx
  require_systemd
  [ "${mode}" = "acme" ] || check_app_tree

  ensure_user
  ensure_dirs
  write_env_file

  [ -L "${NGINX_ENABLED}" ] && previous="$(readlink -f "${NGINX_ENABLED}")"
  install_vhost "${mode}"
  reload_nginx_or_rollback "${previous}"

  install_unit
  systemctl enable "${UNIT_NAME}" >/dev/null

  if [ "${mode}" = "acme" ]; then
    cat <<'EOF'
deploy: ACME bootstrap in place. Next:
  1. mkdir -p /var/www/acme/.well-known/acme-challenge
  2. probe:  printf ok > /var/www/acme/.well-known/acme-challenge/probe
             curl -sS -H 'Host: log.onemipham.com' http://127.0.0.1/.well-known/acme-challenge/probe
             # 必须打印 ok。打印 404/444 就别往下走。
  3. certbot certonly --webroot -w /var/www/acme -d log.onemipham.com
  4. sudo bash deploy.sh install        # 换成完整 vhost
EOF
    return 0
  fi

  systemctl restart "${UNIT_NAME}"
  cat <<'EOF'
deploy: service started. Next:
  sudo bash deploy.sh --check
  systemctl status mipham-telemetry --no-pager
  journalctl -u mipham-telemetry -n 20
EOF
}

cmd_check() {
  require_root
  local drift=0

  # 引导态是**已知的临时状态**，此时比对完整 vhost 必然报漂移 ——
  # 那不是漂移，是没走完流程。明说，而不是丢一堆 diff 出来。
  if [ -f "${NGINX_ENABLED}" ] && ! grep -q 'location = /v1/events' "${NGINX_ENABLED}"; then
    die "still on the ACME bootstrap vhost — run 'deploy.sh install' after certbot"
  fi

  check_one() {
    local label="$1" want="$2" have="$3"
    if [ ! -f "${have}" ]; then
      printf 'DRIFT  %s: %s does not exist\n' "${label}" "${have}"
      drift=1
      return
    fi
    if ! cmp -s "${want}" "${have}"; then
      printf 'DRIFT  %s: %s differs from %s\n' "${label}" "${want}" "${have}"
      diff -u "${want}" "${have}" | head -40
      drift=1
      return
    fi
    printf 'ok     %s\n' "${label}"
  }

  check_one "vhost" "${SRC_VHOST}" "${NGINX_AVAILABLE}"
  check_one "unit" "${SRC_UNIT}" "${UNIT_PATH}"

  if [ ! -L "${NGINX_ENABLED}" ]; then
    printf 'DRIFT  vhost not enabled: %s is not a symlink\n' "${NGINX_ENABLED}"
    drift=1
  else
    printf 'ok     vhost enabled\n'
  fi

  if systemctl is-enabled --quiet "${UNIT_NAME}" 2>/dev/null; then
    printf 'ok     unit enabled\n'
  else
    printf 'DRIFT  unit %s is not enabled\n' "${UNIT_NAME}"
    drift=1
  fi

  if [ -f "${KEY_PATH}" ]; then
    printf 'ok     aggregate key present (fingerprint %s)\n' "$(key_fingerprint)"
  else
    printf 'DRIFT  no aggregate key at %s — run "deploy.sh keys init"\n' "${KEY_PATH}"
    drift=1
  fi

  [ "${drift}" -eq 0 ] || die "drift detected"
  log "no drift"
}

# sha256 前 8 位，与 server.ts 启动日志里的 key= 字段**同一个算法**。
# 两边不一致的话，运维就无法回答「journald 里那个指纹，是不是我手上这把钥匙」。
key_fingerprint() {
  sha256sum "${KEY_PATH}" | cut -c1-8
}

cmd_keys_init() {
  require_root
  ensure_user
  ensure_dirs

  if [ -e "${KEY_PATH}" ]; then
    # 与 crypto.ts 的 generateKey 同一条规则：绝不覆盖。
    # 覆盖 = 历史每日文件全部变成不可解的密文，而现场看起来像一次干净的重来。
    die "refusing to overwrite existing key at ${KEY_PATH} (fingerprint $(key_fingerprint))"
  fi

  command -v openssl >/dev/null 2>&1 || die "openssl not found"

  # openssl 直接吐 32 字节原始数据（不是 base64、不是 hex）—— crypto.ts 的
  # `loadKey` 读的是裸字节且断言长度恰为 32。
  #
  # 先写同目录的临时文件再 mv：mktemp 在 /tmp 建的文件跨文件系统，
  # mv 会退化成 copy+unlink，中间那一刻的密钥可能只有一半。
  local tmp="${KEY_PATH}.tmp.$$"
  umask 077
  openssl rand 32 > "${tmp}"
  [ "$(wc -c < "${tmp}" | tr -d ' ')" = "32" ] || {
    rm -f "${tmp}"
    die "openssl produced the wrong number of bytes"
  }
  chown "${SERVICE_USER}:${SERVICE_USER}" "${tmp}"
  chmod 0400 "${tmp}"
  mv "${tmp}" "${KEY_PATH}"

  log "wrote ${KEY_PATH} (mode 0400, owner ${SERVICE_USER})"
  log "fingerprint: $(key_fingerprint)"
  cat <<'EOF'
deploy: this fingerprint must equal the `key=` field in:
          journalctl -u mipham-telemetry -n 1
        If they differ, the service is reading a different key file.
        BACK THIS FILE UP. Losing it makes every daily aggregate undecryptable.
EOF
}

usage() {
  cat <<'EOF'
usage: deploy.sh <command>

  install [--acme]   install vhost + unit, create user/dirs, reload nginx, start service
                     --acme: install only the port-80 ACME block (before certbot runs)
  --check | check    byte-for-byte diff installed files against this repo copy
  keys init          generate the aggregate encryption key (refuses to overwrite)
EOF
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  --check | check) cmd_check ;;
  keys) [ "${2:-}" = "init" ] || die "unknown: keys ${2:-}"; cmd_keys_init ;;
  -h | --help | "") usage ;;
  *) die "unknown command: $1 (try --help)" ;;
esac
