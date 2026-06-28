#!/bin/bash
# ================================================================
# Mipham Code 国内站 — 腾讯云轻量服务器一键部署
# ================================================================
# 用法: ./deploy-cn.sh [--skip-build]
#
# 服务器: 82.156.254.121 (与 onemipham.com 主站同一服务器)
# 部署路径: /www/wwwroot/onemipham.com/mipham-code/
# 访问: https://onemipham.com/mipham-code
#
# 部署方式: 本地构建 → rsync 静态文件
# ================================================================
set -e

SERVER="root@82.156.254.121"
REMOTE_DIR="/www/wwwroot/onemipham.com/mipham-code"
SKIP_BUILD=false

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
  esac
done

echo "========================================="
echo "  Mipham Code 国内站 → 腾讯云部署"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

# ── 0. 预检 ────────────────────────────────────────────────
echo ""
echo "[0/3] 预检..."

cd "$(dirname "$0")"

if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$SERVER" "echo ok" &>/dev/null; then
  err "无法连接 $SERVER，请检查 SSH"
  exit 1
fi
log "SSH 连接正常"

# ── 1. 构建 ────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo ""
  echo "[1/3] 本地构建..."
  cd apps/web && npx next build && cd ../..
  log "next build 完成"
else
  echo ""
  echo "[1/3] 跳过构建 (--skip-build)"
fi

if [ ! -d "apps/web/out/code" ]; then
  err "apps/web/out/code 不存在，请先构建"
  exit 1
fi

# ── 2. 同步 ────────────────────────────────────────────────
echo ""
echo "[2/3] Rsync → 腾讯云..."

CURRENT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
echo "  commit: $CURRENT_HASH"

ssh "$SERVER" "mkdir -p $REMOTE_DIR"

rsync -avz --delete \
  apps/web/out/code/ \
  "$SERVER:$REMOTE_DIR/"

log "同步完成 ($CURRENT_HASH)"

# ── 3. 验证 ────────────────────────────────────────────────
echo ""
echo "[3/3] 健康检查..."

STATUS=$(ssh "$SERVER" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/mipham-code/" 2>/dev/null || echo "000")
if [ "$STATUS" = "200" ] || [ "$STATUS" = "304" ]; then
  log "HTTP $STATUS — 部署成功"
else
  err "健康检查失败 (HTTP $STATUS)，请检查 Nginx 配置"
  exit 1
fi

echo ""
echo "========================================="
echo "  部署完成 → https://onemipham.com/mipham-code"
echo "  Commit: $CURRENT_HASH"
echo "========================================="
