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
#   5. pnpm-lock.yaml                       — regenerated from package.json changes
#   6. Optionally: local CI checks (with --ci flag)

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
echo "  [1/7] apps/cli/package.json"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('apps/cli/package.json','utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('apps/cli/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "         ✓ $NEW_VERSION"

# ── Step 3: Update package-info.ts (shared + vendored) ──
echo "  [2/7] package-info.ts (shared + vendored)"
for f in packages/shared/src/package-info.ts apps/cli/src/shared/package-info.ts; do
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/PACKAGE_VERSION = '[^']*'/PACKAGE_VERSION = '$NEW_VERSION'/" "$f"
  else
    sed -i "s/PACKAGE_VERSION = '[^']*'/PACKAGE_VERSION = '$NEW_VERSION'/" "$f"
  fi
done
echo "         ✓ $NEW_VERSION"

# ── Step 4: Update packages/shared/package-info.json ──
echo "  [3/7] packages/shared/package-info.json"
node -e "
const fs = require('fs');
const info = JSON.parse(fs.readFileSync('packages/shared/package-info.json','utf8'));
info.PACKAGE_VERSION = '$NEW_VERSION';
fs.writeFileSync('packages/shared/package-info.json', JSON.stringify(info, null, 2) + '\n');
"
echo "         ✓ $NEW_VERSION"

# ── Step 5: Update JetBrains plugin version ──
echo "  [4/7] infrastructure/jetbrains/gradle.properties"
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s/^pluginVersion = .*/pluginVersion = $NEW_VERSION/" infrastructure/jetbrains/gradle.properties
else
  sed -i "s/^pluginVersion = .*/pluginVersion = $NEW_VERSION/" infrastructure/jetbrains/gradle.properties
fi
echo "         ✓ $NEW_VERSION"

# ── Step 6: Sync lockfile ──
echo "  [5/7] pnpm install (sync lockfile)..."
pnpm install --no-frozen-lockfile --silent 2>&1 | tail -1
echo "         ✓ lockfile synced"

# ── Step 7: Format lockfile ──
echo "  [6/7] prettier pnpm-lock.yaml..."
pnpm prettier --write pnpm-lock.yaml --log-level silent 2>/dev/null || true
echo "         ✓ formatted"

# ── Step 8: CI checks (only with --ci; GitHub Actions is the real CI) ──
if $RUN_CI; then
  echo "  [7/7] CI checks..."
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
    echo "   git add apps/cli/package.json packages/shared/src/package-info.ts apps/cli/src/shared/package-info.ts packages/shared/package-info.json infrastructure/jetbrains/gradle.properties pnpm-lock.yaml"
    echo "   git commit -m \"chore: bump version to $NEW_VERSION\""
    echo "   git push origin main"
    echo ""
    echo "   Then: gh release create v$NEW_VERSION --repo One-Mipham/mipham-code ..."
  else
    echo "❌ Some checks failed. Review errors above before committing."
    exit 1
  fi
else
  echo "  [7/7] CI checks... ⏭ skipped (add --ci for local verification)"
  echo "         GitHub Actions CI will run on push."
  echo ""
  echo "✅ Version bumped! Ready to commit:"
  echo ""
  echo "   git add apps/cli/package.json packages/shared/src/package-info.ts apps/cli/src/shared/package-info.ts packages/shared/package-info.json infrastructure/jetbrains/gradle.properties pnpm-lock.yaml"
  echo "   git commit -m \"chore: bump version to $NEW_VERSION\""
  echo "   git push origin main"
  echo ""
  echo "   Then: gh release create v$NEW_VERSION --repo One-Mipham/mipham-code ..."
fi
