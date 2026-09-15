# @mipham/telemetry — 遥测接收端（T1b）

接收 `apps/cli` 发出的匿名遥测（session / crash），**只存维度聚合**。

- 端点：`https://log.onemipham.com/v1/events`（一请求一事件，POST）
- 主机：主机 2（`192.144.235.27`），nginx 终结 TLS，反代到 `127.0.0.1:9099`
- 运行时：Node 22 + systemd（非容器）
- 依赖：**零运行时依赖**，只用 `node:http` / `node:fs` / `node:crypto`

它**不是**通用遥测平台：契约只服务本仓库的 CLI，与 `miphamai4s` 的批量
snake_case 信封**不兼容**（那是另一条路径，本服务不解析它）。

## 状态码由客户端的 ack 语义倒推决定

不是自选的。客户端（`apps/cli/src/telemetry/transport.ts`）把 2xx 与**除 429 外**的
4xx 一律当成功、**删掉本地队列条目**；429 会被重试两次后静默永久丢弃，且一次信号换来
三次请求（负载放大器）。所以：

| 返回                | 客户端行为               | 用在哪                                                    |
| ------------------- | ------------------------ | --------------------------------------------------------- |
| **204**             | ack 删条                 | 成功、重复（`id` 已计过）、字段级问题（丢字段但收下事件） |
| **400**             | ack **删条**（永久丢弃） | 非 JSON / 非对象 / 缺 `id` 或 `kind`。**只在这三种情况**  |
| **404 / 405 / 413** | ack 删条                 | 路径错 / 方法错 / body 超 64 KiB                          |
| **503**             | 重试 → 留队              | 限流触发。**绝不 429**                                    |
| **500**             | 重试 → 留队              | 聚合无法落盘。**唯一的 5xx**                              |
| 3xx                 | 客户端会透明跟随         | **永不产生**（路径用精确匹配）                            |

**永远不发 `Retry-After`**：客户端对它无上限信任（`parseInt` 后乘 1000、无 cap），
`sleep` 又是裸 `setTimeout`（持有事件循环）—— 发出去就是挂住客户端。

**校验必须前向兼容**：`400` 是销毁数据的按钮。服务端部署必然滞后于客户端发布，
所以不因 `schemaVersion` 未知而拒收（记 `unknownSchema++` 照常按已知字段聚合），
也不检查 `Content-Type`（415 是 4xx ⇒ 静默丢数据，而我们本来就要解析这个体）。

## 只存维度聚合

- 分区键 = **服务端接收日（UTC）**，不可伪造。客户端 `occurredAt` 只进偏移桶
  （未校验的时间戳是无界维度）
- `installId` **只喂 HLL**（寄存器，不落任何 id）—— 精确集合落盘的恰恰是「当天的安装清单」
- `stackFrames` 接受但**不留存**，代价记在 `framesDiscarded`
- `counters` 的 label 走**服务端 allowlist**，未收录折叠 `__other__`；
  **原始 label 一个字节都不落盘**（`docs/telemetry.md` 承诺的 no free text）。
  用 allowlist 而不是数值上限，是因为端点是公开无鉴权的：上限可以被填满，
  而没见过的 label 在 allowlist 下根本不占位
- 读取路径**只有离线报告命令**，不开只读 HTTP 端点 ——
  读取的暴露面远大于写入（写入只能投毒，读取能拿走全部聚合）

## 本地开发

```bash
cd apps/telemetry
pnpm test          # vitest run（179 用例 / 12 文件）
pnpm typecheck
pnpm build         # tsc + 把 src/allowlist.json 搬进 dist/
pnpm start         # node dist/server.js（默认 127.0.0.1:9099）
pnpm report --since 7d [--json] [--raw]
pnpm coverage      # 阈值在 vitest.config.ts
```

> **`pnpm build` 少了 `cp src/allowlist.json dist/` 会在启动时 ENOENT。**
> tsc 只 emit `.ts`，而测试跑在 `src/` 下、vitest 原地转换 ⇒ **套件全绿，只有真正
> 发布的那份产物才暴露**。systemd 下表现为重启循环。
> `test/integrity/build-completeness.test.ts` 守住这条不变量。

环境变量全走 `EnvironmentFile`（见 `src/config.ts`），没有配置文件解析。
**密钥只有路径、没有变量** —— 环境变量里的密钥材料会漏进 `systemctl show` 与
`/proc/<pid>/environ`。

## 诚实的边界

- **204 不代表已持久化。** 刷新是「每 25 个已接受事件 / 每 10s」。一次 100 条 burst
  最多丢约 24 条聚合增量（= 25 条窗口 − 1）。若服务端在返回 204 **之前**就死了，
  客户端没收到 204 ⇒ 留队 ⇒ 重发（自愈）；真正会丢的是「已回 204、然后在 flush
  前被杀」这个更窄的窗口
- **崩溃通道能告诉你「什么类型、多深、多少个安装」，但永远不能告诉你崩在哪一行。**
  `stackFrames` 在网络上传输了（所以 `docs/telemetry.md` 没撒谎），只是服务端不保留
- **截断必须与数据同框**：报告把 `__other__` / `labelsOverflow` / `fieldDropped.*` /
  `dedupUnsure` 并排印在真实行旁边 —— 否则「某命令 0 次」与「被折叠进 other」会被
  读成同一件事

## 部署

见 [`deploy/README.md`](deploy/README.md)。vhost 有一处**必须读的注释**：
`ssl_protocols` 在 nginx 里是**并集**语义，照抄本组织其他 vhost 的
`include options-ssl-nginx.conf` 会让 TLS 1.2 依然协商成功，而 `nginx -t`、
读配置、grep 三道检查**全都看不出来**。

```bash
bash deploy/verify-vhost.sh     # 本机拿真 vhost 起对照 nginx，验 TLS/状态码/重定向
```
