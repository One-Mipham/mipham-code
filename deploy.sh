#!/bin/bash
# ================================================================
# Mipham Code — 统一部署入口
# ================================================================
# 用法:
#   ./deploy.sh all          — 部署所有（主站 + 静态页 + marketplace + developer）
#   ./deploy.sh main         — 仅部署主站（含 /mipham-code 页面）
#   ./deploy.sh code         — 仅部署 Mipham Code 静态子页面
#   ./deploy.sh marketplace  — 仅部署 Marketplace（端口 3008）
#   ./deploy.sh developer    — 仅部署 Developer（端口 3009）
#   ./deploy.sh status       — 检查所有服务状态
#
# 架构说明见: memory/onemipham-deploy-architecture.md
# ================================================================
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

SERVER="onemipham"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORP_DIR="$SCRIPT_DIR/.."

CMD="${1:-all}"

show_status() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  onemipham.com 服务状态"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  ssh "$SERVER" "pm2 list" 2>/dev/null || warn "SSH 连接失败"
  echo ""
  echo "健康检查:"
  for url in "https://onemipham.com/" "https://onemipham.com/mipham-code" "https://onemipham.com/marketplace/zh" "https://onemipham.com/developer/zh"; do
    STATUS=$(curl -sk -o /dev/null -w "%{http_code}" "$url")
    if [ "$STATUS" = "200" ] || [ "$STATUS" = "307" ] || [ "$STATUS" = "308" ]; then
      echo -e "  ${GREEN}HTTP $STATUS${NC} — $url"
    else
      echo -e "  ${RED}HTTP $STATUS${NC} — $url"
    fi
  done
}

deploy_main() {
  echo "========================================="
  echo "  主站 → onemipham.com（SSR, 端口 3007）"
  echo "========================================="

  # Sync updated source files
  log "同步 source files..."
  SRC_BASE="$CORP_DIR/websites/domestic/apps/onemipham.com/src"
  REMOTE_BASE="/www/wwwroot/onemipham.com/apps/onemipham.com/src"

  rsync -avz "$SRC_BASE/app/mipham-code/page.tsx"   "$SERVER:$REMOTE_BASE/app/mipham-code/page.tsx"
  rsync -avz "$SRC_BASE/app/page.tsx"                "$SERVER:$REMOTE_BASE/app/page.tsx"
  rsync -avz "$SRC_BASE/config/package-info.json"    "$SERVER:$REMOTE_BASE/config/package-info.json"
  log "源码同步完成"

  # Rebuild on server
  log "重建 Next.js（这可能需要 1-2 分钟）..."
  ssh "$SERVER" "cd /www/wwwroot/onemipham.com/apps/onemipham.com && npx next build" || err "构建失败"
  log "构建完成"

  # Restart PM2
  ssh "$SERVER" "pm2 restart onemipham"
  log "PM2 已重启"
}

deploy_code_static() {
  echo "========================================="
  echo "  Mipham Code 静态页 → /mipham-code/install|docs|dashboard.html"
  echo "========================================="
  cd "$SCRIPT_DIR"
  bash deploy-cn.sh
}

deploy_marketplace() {
  echo "========================================="
  echo "  Marketplace → onemipham.com/marketplace（SSR, 端口 3008）"
  echo "========================================="
  cd "$CORP_DIR/product-platforms/marketplace"
  bash deploy-cn.sh
}

deploy_developer() {
  echo "========================================="
  echo "  Developer → onemipham.com/developer（SSR, 端口 3009）"
  echo "========================================="
  cd "$CORP_DIR/product-platforms/developer"
  bash deploy-cn.sh
}

case "$CMD" in
  status)
    show_status
    ;;
  main)
    deploy_main
    log "主站部署完成 → https://onemipham.com/mipham-code"
    ;;
  code)
    deploy_code_static
    ;;
  marketplace)
    deploy_marketplace
    ;;
  developer)
    deploy_developer
    ;;
  all)
    deploy_main
    deploy_code_static
    deploy_marketplace
    deploy_developer
    log "全部部署完成"
    ;;
  *)
    echo "用法: $0 {all|main|code|marketplace|developer|status}"
    exit 1
    ;;
esac

show_status
