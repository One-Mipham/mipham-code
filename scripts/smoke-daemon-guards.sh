#!/usr/bin/env bash
# Negative cases for the two guard branches of scripts/smoke-daemon.sh.
#
# Why this file exists: ci.yml invokes smoke-daemon.sh twice, and both
# invocations take the happy path — so the branch that keeps $WORK when the
# daemon survives `stop`, and the branch that fails when a successful `start` is
# contradicted by `status`, had never executed anywhere. A guard whose first real
# execution is someone else's push is a guard nobody has read the output of.
#
# The subject under test is the *script*, so the cases run the real thing — same
# compile step, same HOME isolation, same EXIT trap — with a stub CLI in place of
# the artifact: apps/cli/test/fixtures/smoke-daemon-stub-cli, a process whose only
# contract is the question `daemon status` is asked (is the pid file there?). The
# real artifact's happy path is what ci.yml already covers twice; case 1 here is
# its control, so a red case cannot be an always-red script.
#
# Usage: scripts/smoke-daemon-guards.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE="$ROOT/scripts/smoke-daemon.sh"
STUB_CLI="$ROOT/apps/cli/test/fixtures/smoke-daemon-stub-cli"

OUT=''
RC=0
CASE_FAILURES=0
TOTAL_FAILURES=0

ok() { echo "  ✓ $1"; }
bad() {
  echo "  ✗ $1"
  CASE_FAILURES=$((CASE_FAILURES + 1))
}

# Run smoke-daemon.sh once in the given stub mode. `|| rc=$?` rather than a bare
# assignment: the negative cases *expect* a non-zero exit, and under `set -e` a
# blanket failure here would abort before the assertion that wanted it.
run_case() {
  local mode="$1"
  RC=0
  OUT="$(SMOKE_STUB_MODE="$mode" bash "$SMOKE" "$STUB_CLI" 2>&1)" || RC=$?
  # The work dir is discovered, never assumed: the stub is compiled into it and
  # reports its own path first thing, so this works on both the kept (WARN) and
  # the deleted (FAIL) side of the run.
  WORK="$(printf '%s\n' "$OUT" | sed -n 's/^\[stub\] execPath=//p' | sed -n '1p')"
  WORK="${WORK%/mipham}"
}

contains() {
  case "$OUT" in
    *"$1"*) return 0 ;;
    *) return 1 ;;
  esac
}

# First line of $OUT containing the given substring. Deliberately bash-native:
# `printf | grep | head` is the same pipeline-SIGPIPE shape this script's subject
# spent a Ruling removing, and an assertion that can be silenced by a 141 is a
# worse assertion than a slow one.
line_with() {
  local line
  while IFS= read -r line; do
    case "$line" in
      *"$1"*)
        printf '%s\n' "$line"
        return 0
        ;;
    esac
  done <<< "$OUT"
  return 0
}

expect_rc() {
  # `${RC}，` 的花括号不是风格：bash 按当前 locale 的 isalnum 取变量名，UTF-8 下
  # 全角逗号/括号算字母 ⇒ `$RC，` 会被当成一个不存在的变量名（`set -u` 下当场中止）。
  if [ "$RC" = "$2" ]; then ok "$1"; else bad "$1（实际 rc=${RC}，期望 $2）"; fi
}
expect_contains() {
  if contains "$2"; then ok "$1"; else bad "$1（输出里没有：$2）"; fi
}
expect_absent() {
  if contains "$2"; then bad "$1（输出里不该有：$2）"; else ok "$1"; fi
}
expect_line_contains() { # <desc> <行定位子串> <该行必须有的文本>
  local line
  line="$(line_with "$2")"
  if [ -z "$line" ]; then
    bad "$1（没有任何一行含 $2）"
  elif case "$line" in *"$3"*) true ;; *) false ;; esac; then
    ok "$1"
  else
    bad "$1（那一行是：${line}）"
  fi
}
expect_file() { # <desc> <path> <存在|不存在>
  if [ "$3" = '存在' ]; then
    if [ -e "$2" ]; then ok "$1"; else bad "$1（$2 不在）"; fi
  else
    if [ -e "$2" ]; then bad "$1（$2 仍在）"; else ok "$1"; fi
  fi
}

begin_case() {
  echo "→ $1"
  CASE_FAILURES=0
}
end_case() {
  if [ "$CASE_FAILURES" -gt 0 ]; then
    TOTAL_FAILURES=$((TOTAL_FAILURES + CASE_FAILURES))
    echo "  --- 该用例的完整输出 ---"
    printf '%s\n' "$OUT" | sed 's/^/  | /'
  fi
}

# ---------------------------------------------------------------- case 1 (control)
# A red negative case proves nothing if the script is red for everything, so the
# happy path runs first and must be green on the same fixture.
begin_case 'ok —— 正对照：同一套 fixture 上的 happy path 必须绿'
run_case ok
expect_rc '退出码 0' 0
expect_contains '打印通过' '✓ compiled-binary daemon smoke test passed'
expect_absent '没有走到 WARN 分支' 'WARN: daemon'
expect_absent '没有走到 FAIL 分支' 'FAIL: daemon start returned success'
expect_file 'work 目录已按常规清掉' "$WORK/mipham" '不存在'
end_case

# ------------------------------------------------- case 2: daemon survives `stop`
# "保留 $WORK" 分支。它的 load-bearing 处是那条 `exit 1`：没有它，`case` 命中后会
# 直落到函数末尾的 `rm -rf` —— 同样打印告警、$WORK 被删、daemon 仍在 LISTEN。
# 所以这里钉的是三件事：退出码、告警原文、以及 $WORK 真的还在。
begin_case 'survives-stop —— daemon 扛过 stop：保留 $WORK 并红'
run_case survives-stop
expect_rc '退出码 1（不是删除后谎报通过）' 1
expect_contains '打印保留告警' 'WARN: daemon'
# 钉在**告警那一行**上，不搜整段输出：stub 的 `daemon status` 本来就打印 `PID:
# 4242`，整段搜索下这条断言与「告警里有没有 pid」无关 —— 它就是绿的了。
expect_line_contains '告警那一行带上从 status 解析出的 PID' 'WARN: daemon' '4242'
expect_absent '没有误报成 FAIL' 'FAIL: daemon start returned success'
expect_file 'work 目录被保留' "$WORK/mipham" '存在'
expect_file '被保留的是活 daemon 的状态' "$WORK/home/.mipham/daemon.pid" '存在'
# 这一支刻意留着现场，清理归本脚本 —— 判据先自证目标像不像那个 mktemp 目录。
if [ -d "$WORK/home" ] && [ -d "$WORK/task" ] && [ "$WORK" != '/' ]; then
  rm -rf "$WORK"
else
  bad "拒绝对形状不对的路径做 rm -rf：$WORK"
fi
end_case

# -------------------------------------------- case 3: start succeeded, status denies it
# 「探针误读」分支。这里两侧的清理是**刻意不对称**的：daemon 确已不在跑，trap 里
# 的 stop 能成功，所以 $WORK 该被删掉 —— 断言它没了，才说明这条路上的 FAIL 不是
# 靠保留现场换来的。
begin_case 'never-ready —— start 报成功而 status 否认：红且不留下目录'
run_case never-ready
expect_rc '退出码 1' 1
expect_contains '点名是 start 与 status 的矛盾' 'FAIL: daemon start returned success but status is not running'
expect_absent '没有误报成「仍在跑」' 'WARN: daemon'
expect_file 'work 目录已被清掉（与 case 2 刻意相反）' "$WORK/mipham" '不存在'
end_case

echo
if [ "$TOTAL_FAILURES" -eq 0 ]; then
  echo "✓ smoke-daemon 守卫分支用例全部通过（3 个用例）"
else
  echo "✗ smoke-daemon 守卫分支用例失败 $TOTAL_FAILURES 项"
  exit 1
fi
