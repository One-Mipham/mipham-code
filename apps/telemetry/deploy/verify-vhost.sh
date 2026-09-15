#!/usr/bin/env bash
#
# Mipham Code — 在本机拿**真正要发布的那份 vhost** 起一个对照 nginx 跑验证
#
#   bash verify-vhost.sh            # 全部检查
#   bash verify-vhost.sh --keep     # 留着工作目录，便于排查
#
# 为什么必须有这个脚本：TLS 那几条配置如果用眼睛看、用 `nginx -t` 验、用 grep 找，
# **三道看似是证明的东西全是假的** —— 实测过 include + 覆盖 `ssl_protocols` 的写法
# 仍然协商成功 TLS 1.2，而 `nginx -t` 只报一句 duplicate value 的警告。唯一能证伪的是
# 一次真握手。不把这套流程固化下来，它下次还是会被「看起来对」骗过去。
#
# **但它证不了生产的协议集**（2026-09-15 上线后实测）：同一 443 地址上版本由**默认
# server** 决定、而非匹配到的那一块，且这件事随 nginx 版本翻转（1.24 不修，1.29.2 起
# 才随 ClientHello 回调式 SNI 匹配修掉）。故本脚本只断言「这份 vhost **声明**的协议集
# 被真的服务出去」，生产的实际协议集与已知偏离见 deploy/README.md。
#
# 依赖：本机 nginx（brew 即可）、openssl、curl、node（起桩上游）。
# 端口用 18080/18443 与 19099，避开常见的 8080/8443。
#
# **转换的诚实性**：脚本不另写一份 vhost，而是 sed 发行版那份，然后把 diff 打出来
# 逐行断言「只改了允许改的行」。所以「测的就是要发布的那份」这句话是被机械证明的，
# 不是承诺的。

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_VHOST="${SELF_DIR}/nginx/log.onemipham.com.conf"

HTTP_PORT=18080
HTTPS_PORT=18443
UPSTREAM_PORT=19099
HOST=log.onemipham.com

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

fail() {
  printf 'verify-vhost: FAIL — %s\n' "$1" >&2
  exit 1
}
pass() { printf '  ok   %s\n' "$1"; }
info() { printf '\n== %s ==\n' "$1"; }

for tool in nginx openssl curl node; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} not found"
done
[ -f "${SRC_VHOST}" ] || fail "missing ${SRC_VHOST}"

WORK="$(mktemp -d)"
NGINX_PID=""
STUB_PID=""
cleanup() {
  # 按 pid 文件杀，不用 pkill —— 本机可能同时跑着别的 nginx（brew services 起的那种）。
  # 曾经因为 pkill 没匹配上而留了一个旧进程在听同一个端口，于是「改完重启」验的是
  # **旧进程**的配置，TLS 1.2 显示被接受 —— 一次彻头彻尾的假绿。
  if [ -f "${WORK}/nginx.pid" ]; then
    nginx -s quit -c "${WORK}/nginx.conf" -p "${WORK}" 2>/dev/null || true
    sleep 0.3
    if [ -f "${WORK}/nginx.pid" ]; then
      kill -9 "$(cat "${WORK}/nginx.pid")" 2>/dev/null || true
    fi
  fi
  [ -n "${STUB_PID}" ] && kill "${STUB_PID}" 2>/dev/null || true
  if [ "${KEEP}" = "1" ]; then
    printf 'verify-vhost: work dir kept at %s\n' "${WORK}"
  else
    rm -rf "${WORK}"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 0. 自签证书（只为本地握手，与线上证书无关）
# ---------------------------------------------------------------------------
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "${WORK}/key.pem" -out "${WORK}/cert.pem" \
  -subj "/CN=${HOST}" >/dev/null 2>&1

# ---------------------------------------------------------------------------
# 1. 变换：sed 那份发行版 vhost，改端口 / 证书 / 日志路径 / ACME root
# ---------------------------------------------------------------------------
mkdir -p "${WORK}/acme" "${WORK}/logs"
sed \
  -e "s#^\( *\)listen 80;#\1listen 127.0.0.1:${HTTP_PORT};#" \
  -e "s#^\( *\)listen \[::\]:80;#\1listen [::1]:${HTTP_PORT};#" \
  -e "s#^\( *\)listen 443 ssl http2;#\1listen 127.0.0.1:${HTTPS_PORT} ssl http2;#" \
  -e "s#^\( *\)listen \[::\]:443 ssl http2;#\1listen [::1]:${HTTPS_PORT} ssl http2;#" \
  -e "s#/etc/letsencrypt/live/[^/]*/fullchain.pem#${WORK}/cert.pem#" \
  -e "s#/etc/letsencrypt/live/[^/]*/privkey.pem#${WORK}/key.pem#" \
  -e "s#^\( *access_log \)/var/log/nginx/[^ ]*#\1${WORK}/logs/access.log#" \
  -e "s#^\( *error_log \)/var/log/nginx/[^ ]*;#\1${WORK}/logs/error.log;#" \
  -e "s#^\( *root \)/var/www/acme;#\1${WORK}/acme;#" \
  -e "s#http://127.0.0.1:9099#http://127.0.0.1:${UPSTREAM_PORT}#" \
  "${SRC_VHOST}" > "${WORK}/vhost.conf"

info "变换只改了这些行（其余逐字未动）"
diff -u "${SRC_VHOST}" "${WORK}/vhost.conf" || true
# 逐行断言：允许被改的**指令**只有 listen / 证书 / 日志 / ACME root / proxy_pass。
# 白名单钉在指令名上而不是钉在替换后的路径上 —— 后者在改 sed 时会悄悄过期
# （本次就是这样：error_log 被误改成 access.log 的路径，而白名单因为只认
# `/var/log/nginx/` 这个前缀，差点放行）。出现任何别的 -/+ 行就说明变换动了
# 不该动的东西，那「测的是发布版」这句话立刻变成假的。
UNEXPECTED="$(diff -u "${SRC_VHOST}" "${WORK}/vhost.conf" \
  | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' \
  | grep -vE '^[+-][[:space:]]*(listen |ssl_certificate|access_log |error_log |root |proxy_pass )' || true)"
[ -z "${UNEXPECTED}" ] || fail "sed 动了意料之外的行：
${UNEXPECTED}"
pass "diff 只包含允许的替换"

# 顺便证明变换真的生效了（否则上面的断言会因为「什么都没改」而恒真）
grep -q "listen 127.0.0.1:${HTTPS_PORT} ssl http2;" "${WORK}/vhost.conf" \
  || fail "listen 端口没被改写 —— 变换没生效，上面的断言是空转的"
pass "listen 端口改写生效"

# ---------------------------------------------------------------------------
# 2. 桩上游
#
# 只复刻**契约里的状态码**，不复刻聚合逻辑（那是 apps/telemetry 单测的事）。
# 这里的断言对象是 nginx：它有没有原样转发方法、有没有原样透传状态码、
# 有没有在我们没要求的时候插一个 3xx 进来。所以桩上写着 405 就必须收到 405
# —— 一旦 nginx 插手（limit_except 会给 403），这个断言立刻红。
# ---------------------------------------------------------------------------
node -e "
const http = require('node:http')
const seen = []
http.createServer((req, res) => {
  seen.push(req.method + ' ' + req.url)
  // 非 POST ⇒ 405（应用自己的路由，不是 nginx 的）
  if (req.method !== 'POST') { res.writeHead(405); return res.end() }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let parsed
    try { parsed = JSON.parse(body) } catch { res.writeHead(400); return res.end() }
    if (typeof parsed !== 'object' || parsed === null || !parsed.id || !parsed.kind) {
      res.writeHead(400); return res.end()
    }
    res.writeHead(204); res.end()
  })
}).listen(${UPSTREAM_PORT}, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
" &
STUB_PID=$!
sleep 0.6
kill -0 "${STUB_PID}" 2>/dev/null || fail "桩上游没起来（端口 ${UPSTREAM_PORT} 被占？）"

# ---------------------------------------------------------------------------
# 3. 启动对照 nginx
# ---------------------------------------------------------------------------
cat > "${WORK}/nginx.conf" <<EOF
worker_processes 1;
error_log ${WORK}/logs/error.log warn;
pid ${WORK}/nginx.pid;
events { worker_connections 64; }
http {
    access_log ${WORK}/logs/all.log;
    client_body_temp_path ${WORK}/body;
    proxy_temp_path ${WORK}/proxy;
    fastcgi_temp_path ${WORK}/fastcgi;
    uwsgi_temp_path ${WORK}/uwsgi;
    scgi_temp_path ${WORK}/scgi;
    include ${WORK}/vhost.conf;
}
EOF

nginx -t -c "${WORK}/nginx.conf" -p "${WORK}" >/dev/null 2>&1 \
  || { nginx -t -c "${WORK}/nginx.conf" -p "${WORK}"; fail "nginx -t 不通过"; }
nginx -c "${WORK}/nginx.conf" -p "${WORK}"
sleep 0.6

# 确认在听的**就是**我们刚起的这个进程。这一步不能省 —— 见 cleanup() 里的注释。
RUNNING_PID="$(cat "${WORK}/nginx.pid" 2>/dev/null || true)"
[ -n "${RUNNING_PID}" ] || fail "nginx 没写出 pid 文件"
kill -0 "${RUNNING_PID}" 2>/dev/null || fail "pid ${RUNNING_PID} 不在运行"
pass "nginx 起来了（pid ${RUNNING_PID}）"

BASE=(--resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" --resolve "${HOST}:${HTTP_PORT}:127.0.0.1" -sk)

# ---------------------------------------------------------------------------
# 4. TLS：断言「声明的协议集被真的服务出去」
#
# **先看这段边界**：本脚本**证不了生产的协议集**。单 vhost 的对照 nginx 里，这一块既是
# 默认 server 也是匹配块，两种 nginx 版本下结论一致；而生产上同一地址有 api/quant/log
# 三块，版本由**默认 server（api）**决定 —— 测的拓扑与生产不同。详见文件头的说明。
#
# **这里栽过一次，务必读这段。** 直觉写法是 grep `Protocol  :` 然后看它是不是
# TLSv1.2 —— 而**握手失败时那一行照样是 TLSv1.2**（它报的是客户端*提议*的版本，
# 不是协商结果）。实测一次被拒的 TLS 1.2 握手，输出同时含：
#     error:...tlsv1 alert protocol version ... SSL alert number 70
#     New, (NONE), Cipher is (NONE)
#     Protocol: TLSv1.2          ← 假的「成功」
#     Cipher    : 0000
# 所以「拒绝」会被这个检查读成「接受」。判据只有一个：`New, <协议>, Cipher is <套件>`
# 这一行里，套件不是 `(NONE)` 才算握手成立，那一格才是**协商出来的**协议。
# （vhost 注释里已记过同族的坑：`grep -c "Cipher is"` 也匹配 `Cipher is (NONE)`,
#  本仓库曾据此产出两份误报。同一个坑换了个字段又踩一次 —— 判据要钉在
#  「协商结果」上，而不是钉在「输出里出现过某个词」上。）
# ---------------------------------------------------------------------------
info "TLS 协议集（声明 vs 实服务）"
tls_proto() { # 成功打印协商出的协议名；握手失败打印空串
  local line
  line="$(openssl s_client -connect "127.0.0.1:${HTTPS_PORT}" "$@" -servername "${HOST}" \
    < /dev/null 2>/dev/null | grep -m1 -E '^New, ' || true)"
  case "${line}" in
    '' | *'Cipher is (NONE)'*) printf '' ;;
    *) printf '%s' "${line}" | sed -E 's/^New, ([^,]+), Cipher is .*/\1/' ;;
  esac
}

# 先自检这个判据函数本身：它必须能报出一次真成功的握手。
# 下面那条「TLS 1.2 应当成功」是个**肯定式**断言（要求它非空），所以判据恒返回空时它
# 会红而不是恒绿；而 TLS 1.1 那条是**否定式**（要求它为空），判据坏了它就会空转恒绿 ——
# 自检放在两者之前，正是为了堵住后者的空转。
P13="$(tls_proto -tls1_3)"
[ "${P13}" = "TLSv1.3" ] || fail "TLS 1.3 握手失败（判得 ${P13:-空}）—— 服务不可用，或判据函数坏了"
pass "TLS 1.3 握手成功（协商 Protocol=TLSv1.3）"

# vhost 声明的是 `ssl_protocols TLSv1.2 TLSv1.3;`（写全而非 TLSv1.3-only 的理由见它自己的
# 注释：在 1.24 上那条指令管不到握手版本，写 1.3-only 只会让配置与行为不符）。这里断言的是
# **声明与实服务一致**，不是「TLS 1.2 被禁」—— 后者在主机 2 的 nginx 上根本做不到。
P12="$(tls_proto -tls1_2)"
[ "${P12}" = "TLSv1.2" ] \
  || fail "TLS 1.2 是 vhost 声明的协议集之一，握手却没成（判得 ${P12:-空}）—— \
服务不可用、判据函数坏了，或声明与行为已经不符"
pass "TLS 1.2 握手成功（协商 Protocol=TLSv1.2，与声明一致）"

P11="$(tls_proto -tls1_1)"
if [ -n "${P11}" ]; then
  fail "TLS 1.1 握手成功（协商 Protocol=${P11}）—— 它**不在** vhost 声明的协议集里"
fi
pass "TLS 1.1 被拒绝（未声明即不服务）"

# ---------------------------------------------------------------------------
# 5. 状态码矩阵 + 「永不重定向」
# ---------------------------------------------------------------------------
info "状态码与重定向"
code() { # 打印状态码；-o /dev/null 丢掉 body
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

C="$(code "${BASE[@]}" "https://${HOST}:${HTTPS_PORT}/v1/events" \
  -X POST -H 'Content-Type: application/json' -d '{"id":"a","kind":"session"}')"
[ "${C}" = "204" ] || fail "合法 POST 应为 204，实得 ${C}"
pass "合法 POST ⇒ 204"

C="$(code "${BASE[@]}" -X GET "https://${HOST}:${HTTPS_PORT}/v1/events")"
[ "${C}" = "405" ] || fail "GET 应为 405（app 的路由），实得 ${C} —— 403 说明 nginx 的 limit_except 掺和进来了"
pass "GET /v1/events ⇒ 405（不是 403、不是 404：nginx 没插手）"

C="$(code "${BASE[@]}" "https://${HOST}:${HTTPS_PORT}/v1/event")"
[ "${C}" = "404" ] || fail "错路径应为 404，实得 ${C}"
pass "错拼路径 ⇒ 404（契约漂移必须看得出来）"

C="$(code "${BASE[@]}" -X POST -H 'Content-Type: application/json' -d 'not json' \
  "https://${HOST}:${HTTPS_PORT}/v1/events")"
[ "${C}" = "400" ] || fail "畸形 JSON 应为 400，实得 ${C}"
pass "畸形 JSON ⇒ 400"

# 任何路径、任何方法都不能出现 3xx 或 Location。
# 这一条是集团 §二 的载体：3xx 会被客户端透明跟随，而跟随意味着**明文第一跳**
# 已经把事件体发出去了（undici 默认 redirect:'follow'）。
for path in / /v1/events /v1/events/ /v1/ /foo/bar /v1/events?x=1; do
  for method in GET POST HEAD; do
    out="$(curl -s -D - -o /dev/null "${BASE[@]}" -X "${method}" \
      "https://${HOST}:${HTTPS_PORT}${path}" 2>/dev/null || true)"
    sc="$(printf '%s' "${out}" | head -1 | awk '{print $2}')"
    case "${sc}" in
      3*) fail "${method} ${path} 返回 ${sc} —— 永不允许 3xx" ;;
    esac
    printf '%s' "${out}" | grep -qi '^location:' \
      && fail "${method} ${path} 带 Location 头 —— 永不允许"
  done
done
pass "6 路径 × 3 方法：无 3xx、无 Location"

# body 上限：nginx 在读体之前就回 413（客户端按 4xx 丢弃，正是想要的）
head -c 70000 /dev/zero | tr '\0' 'a' > "${WORK}/big.json"
C="$(code "${BASE[@]}" -X POST -H 'Content-Type: application/json' \
  --data-binary "@${WORK}/big.json" "https://${HOST}:${HTTPS_PORT}/v1/events")"
[ "${C}" = "413" ] || fail "70 KiB 应为 413，实得 ${C}"
pass "70 KiB ⇒ 413"

# ---------------------------------------------------------------------------
# 6. 80 端口：ACME 可服务，其余 444 且不重定向
# ---------------------------------------------------------------------------
info "80 端口"
mkdir -p "${WORK}/acme/.well-known/acme-challenge"
printf 'probe-ok' > "${WORK}/acme/.well-known/acme-challenge/probe"
OUT="$(curl -s -H "Host: ${HOST}" "http://127.0.0.1:${HTTP_PORT}/.well-known/acme-challenge/probe")"
[ "${OUT}" = "probe-ok" ] || fail "ACME 挑战取不到（实得 '${OUT}'）—— 续期会失败"
pass "ACME 挑战可服务（不然 certbot 续期会静默烂掉）"

# 其余路径必须是 444：不发响应、不发 Location、**不读体**
OUT="$(curl -s -D - -o /dev/null -H "Host: ${HOST}" \
  -X POST --data 'secret' "http://127.0.0.1:${HTTP_PORT}/v1/events" 2>&1 || true)"
printf '%s' "${OUT}" | grep -qi '^HTTP/' \
  && fail "80 端口对 /v1/events 回应了（${OUT}）—— 必须是 444：无响应、无 Location"
printf '%s' "${OUT}" | grep -qi '^location:' \
  && fail "80 端口发了 Location —— 明文第一跳的风险成真"
pass "80 端口 /v1/events ⇒ 444（无响应、无 Location）"

# ---------------------------------------------------------------------------
# 7. 日志不记查询串
#
# $request 含 $args，而查询串是客户端可控的自由文本 —— 塞换行符即可伪造日志行。
# 用一个特征鲜明的 marker 打一发，再去 access log 里找它。
# ---------------------------------------------------------------------------
info "日志"
curl -s -o /dev/null "${BASE[@]}" -X POST -H 'Content-Type: application/json' \
  -d '{"id":"a","kind":"session"}' \
  "https://${HOST}:${HTTPS_PORT}/v1/events?marker=FORGEDLINE" || true
sleep 0.3
if grep -q 'FORGEDLINE' "${WORK}/logs/access.log" 2>/dev/null; then
  fail "访问日志里出现了查询串（marker=FORGEDLINE）—— \$request 通道未关"
fi
pass "访问日志不含查询串"

# ---------------------------------------------------------------------------
printf '\nverify-vhost: ALL PASS\n'
printf '  验的是这份文件：%s\n' "${SRC_VHOST}"
printf '  它的 sha256：%s\n' "$(openssl dgst -sha256 -r "${SRC_VHOST}" | cut -c1-16)"
