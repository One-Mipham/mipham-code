#!/usr/bin/env bash
# bump-version.sh — Bump Mipham Code version across all files, sync lockfile.
#
# Usage: ./scripts/bump-version.sh <new-version> [--ci]
# Example: ./scripts/bump-version.sh 0.16.3          # fast: bump only
# Example: ./scripts/bump-version.sh 0.16.3 --ci     # slow: also run local CI checks
#
# By default, CI checks are SKIPPED — GitHub Actions is the real CI.
# Use --ci only when you want pre-push verification locally.
#
# Updates:
#   1. apps/cli/package.json                — "version" field
#   2. package-info.ts (shared + vendored)  — PACKAGE_VERSION constant
#   3. packages/shared/package-info.json     — PACKAGE_VERSION field
#   4. infrastructure/jetbrains/gradle.properties — pluginVersion
#   5. infrastructure/vscode/package.json   — "version" field
#   6. 活文档里**用户会照着做**的版本引用（5 处 / 4 个文件）—— 见下面 Step 7 的清单
#   7. pnpm-lock.yaml                       — regenerated from package.json changes
#   8. Optionally: local CI checks (with --ci flag)
#
# Step 6 是 2026-09-28 补的：那 5 处从前**不在任何清单里**，实测各漂各的
# （CLI README 的 H1 停在 0.81.7、JetBrains zip 名停在 0.44.0、macOS dmg 名停在 0.21.0、
# 根 README 的 config.yml 示例停在 0.83.0）。守卫见
# apps/cli/test/integrity/doc-version-refs.test.ts（它同时守反方向：产物名不得钉死版本）。
#
# **不**在这里改的（别顺手加）：CLAUDE.md 头部的批次标签 —— 它是一句带描述的散文，
# 由「文档回填」那一笔手写；CHANGELOG ×3 —— 逐版本新增段落，不是替换。

set -euo pipefail

RUN_CI=false
for arg in "$@"; do
  case "$arg" in
    --ci) RUN_CI=true ;;
    *) NEW_VERSION="${NEW_VERSION:-$arg}" ;;
  esac
done

if [ -z "${NEW_VERSION:-}" ]; then
  echo "Usage: $0 <new-version> [--ci]"
  echo "Example: $0 0.16.3"
  echo "Example: $0 0.16.3 --ci  (also run local CI checks)"
  exit 1
fi

# Validate semver-ish format
if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "❌ Invalid version format: $NEW_VERSION (expected X.Y.Z or X.Y.Z-prerelease)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# ── Step 0: Check clean working tree ──
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo "❌ Working tree is dirty. Please commit or stash changes first."
  exit 1
fi

# ── Step 1: Get current version ──
CURRENT=$(node -e "console.log(require('./apps/cli/package.json').version)")
echo "📦 Bumping: $CURRENT → $NEW_VERSION"
echo ""

# ── Step 2: Update apps/cli/package.json ──
echo "  [1/9] apps/cli/package.json"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('apps/cli/package.json','utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('apps/cli/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "         ✓ $NEW_VERSION"

# ── Step 3: Update package-info.ts (shared + vendored) ──
echo "  [2/9] package-info.ts (shared + vendored)"
for f in packages/shared/src/package-info.ts apps/cli/src/shared/package-info.ts; do
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/PACKAGE_VERSION = '[^']*'/PACKAGE_VERSION = '$NEW_VERSION'/" "$f"
  else
    sed -i "s/PACKAGE_VERSION = '[^']*'/PACKAGE_VERSION = '$NEW_VERSION'/" "$f"
  fi
done
echo "         ✓ $NEW_VERSION"

# ── Step 4: Update packages/shared/package-info.json ──
echo "  [3/9] packages/shared/package-info.json"
node -e "
const fs = require('fs');
const info = JSON.parse(fs.readFileSync('packages/shared/package-info.json','utf8'));
info.PACKAGE_VERSION = '$NEW_VERSION';
fs.writeFileSync('packages/shared/package-info.json', JSON.stringify(info, null, 2) + '\n');
"
echo "         ✓ $NEW_VERSION"

# ── Step 5: Update JetBrains plugin version ──
echo "  [4/9] infrastructure/jetbrains/gradle.properties"
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/^pluginVersion = .*/pluginVersion = $NEW_VERSION/" infrastructure/jetbrains/gradle.properties
else
  sed -i "s/^pluginVersion = .*/pluginVersion = $NEW_VERSION/" infrastructure/jetbrains/gradle.properties
fi
echo "         ✓ $NEW_VERSION"

# ── Step 6: Update VS Code extension version ──
echo "  [5/9] infrastructure/vscode/package.json"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('infrastructure/vscode/package.json','utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('infrastructure/vscode/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "         ✓ $NEW_VERSION"

# ── Step 7: Sync live docs' version references ──
# 用户会照着做的 5 处：安装输出示例 / config.yml 示例 / npm 包页 H1 / 两个下载文件名。
# **不改**的：构建产物行（`# Output: …-<version>.zip`）—— 它们本来就该是占位；
# 谁把它们钉死了，守卫会红（见文件头）。也不改 CHANGELOG ×3 与 CLAUDE.md 头部。
echo "  [6/9] 活文档版本引用（5 处 / 4 个文件）"
sync_doc() {
  local file="$1" expr="$2" expect="$3"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "$expr" "$file"
  else
    sed -i "$expr" "$file"
  fi
  # sed 失配是**静默**的：什么都没改与「本来就已经对了」打印同一个结果。
  # 所以改完回读那一行 —— 对不上就停在这里，别让它漂到下一个版本。
  if ! grep -qF -- "$expect" "$file"; then
    echo "         ❌ $file 没改成 —— sed 模式可能已与文件脱节"
    echo "            期望出现: $expect"
    exit 1
  fi
}
sync_doc README.md \
  "s|^# → @miphamai/cli v[0-9][0-9.]*\$|# → @miphamai/cli v$NEW_VERSION|" \
  "# → @miphamai/cli v$NEW_VERSION"
sync_doc README.md \
  "s|^version: '[0-9][0-9.]*'\$|version: '$NEW_VERSION'|" \
  "version: '$NEW_VERSION'"
sync_doc apps/cli/README.md \
  "s|^# Mipham Code v[0-9][0-9.]*\$|# Mipham Code v$NEW_VERSION|" \
  "# Mipham Code v$NEW_VERSION"
sync_doc infrastructure/jetbrains/README.md \
  "s|mipham-code-jetbrains-[0-9][0-9.]*\.zip|mipham-code-jetbrains-$NEW_VERSION.zip|" \
  "mipham-code-jetbrains-$NEW_VERSION.zip"
sync_doc infrastructure/macos/README.md \
  "s|mipham-code-[0-9][0-9.]*\.dmg|mipham-code-$NEW_VERSION.dmg|" \
  "mipham-code-$NEW_VERSION.dmg"
echo "         ✓ $NEW_VERSION"

# ── Step 8: Sync lockfile ──
echo "  [7/9] pnpm install (sync lockfile)..."
pnpm install --no-frozen-lockfile --silent 2>&1 | tail -1
echo "         ✓ lockfile synced"

# ── Step 9: Format lockfile ──
echo "  [8/9] prettier pnpm-lock.yaml..."
pnpm prettier --write pnpm-lock.yaml --log-level silent 2>/dev/null || true
echo "         ✓ formatted"

# ── Step 9: CI checks (only with --ci; GitHub Actions is the real CI) ──
if $RUN_CI; then
  echo "  [9/9] CI checks..."
  echo ""
  FAILED=0

  echo -n "    typecheck ... "
  if pnpm -r typecheck >/dev/null 2>&1; then
    echo "✓"
  else
    echo "❌"
    FAILED=1
  fi

  echo -n "    lint ..... "
  if pnpm lint >/dev/null 2>&1; then
    echo "✓"
  else
    echo "❌"
    FAILED=1
  fi

  echo -n "    format ... "
  if pnpm format:check >/dev/null 2>&1; then
    echo "✓"
  else
    echo "❌"
    FAILED=1
  fi

  echo -n "    build .... "
  if pnpm -r build >/dev/null 2>&1; then
    echo "✓"
  else
    echo "❌"
    FAILED=1
  fi

  echo -n "    test ..... "
  if pnpm -r test >/dev/null 2>&1; then
    echo "✓"
  else
    echo "❌"
    FAILED=1
  fi

  echo ""

  if [ $FAILED -eq 0 ]; then
    echo "✅ Local CI passed! Ready to commit:"
    echo ""
    echo "   git add apps/cli/package.json packages/shared/src/package-info.ts apps/cli/src/shared/package-info.ts packages/shared/package-info.json infrastructure/jetbrains/gradle.properties infrastructure/vscode/package.json"
    echo "   git add README.md apps/cli/README.md infrastructure/jetbrains/README.md infrastructure/macos/README.md pnpm-lock.yaml"
    echo "   git commit -m \"chore: bump version to $NEW_VERSION\""
    echo "   git push origin main"
    echo ""
    echo "   Then: gh release create v$NEW_VERSION --repo One-Mipham/mipham-code ..."
  else
    echo "❌ Some checks failed. Review errors above before committing."
    exit 1
  fi
else
  echo "  [9/9] CI checks... ⏭ skipped (add --ci for local verification)"
  echo "         GitHub Actions CI will run on push."
  echo ""
  echo "✅ Version bumped! Ready to commit:"
  echo ""
  echo "   git add apps/cli/package.json packages/shared/src/package-info.ts apps/cli/src/shared/package-info.ts packages/shared/package-info.json infrastructure/jetbrains/gradle.properties infrastructure/vscode/package.json pnpm-lock.yaml"
  echo "   git commit -m \"chore: bump version to $NEW_VERSION\""
  echo "   git push origin main"
  echo ""
  echo "   Then: gh release create v$NEW_VERSION --repo One-Mipham/mipham-code ..."
fi
