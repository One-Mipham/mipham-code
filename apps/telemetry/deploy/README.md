# 遥测接收端 · 部署 runbook

目标机：主机 2（`192.144.235.27`，Ubuntu 24.04 / nginx 1.24.0 / systemd 255）。
同机还跑着 `api.onemipham.com` 与 `quant.onemipham.com` —— **每一步都不要把它们带下去**。

```
deploy.sh install [--acme]   铺 vhost + unit、建用户/目录、reload nginx、起服务
deploy.sh --check            与线上逐字 diff，有漂移则非零退出
deploy.sh keys init          生成聚合加密密钥（拒绝覆盖）
install-node.sh              官方 tarball + 校验和解到 /opt（不加 apt 源）
verify-vhost.sh              【本机】拿真 vhost 起对照 nginx，验 TLS/状态码/重定向
```

## 为什么脚本在主机上跑，而应用不是它铺的

`--check` 的参照物是**一份已同步到主机的仓库副本**。若脚本自带资产、又自己解包到
`/etc`，那 diff 就成了拿刚写下的内容比对它自己 —— 恒绿，等于没有检查。所以：

**应用本体（`dist/`）由开发机产出后 rsync 上去。** 本目录的脚本只管配置与校验。

主机上只有**一棵树** `/opt/mipham-telemetry/`，它同时是运行根和比对参照：

```
/opt/mipham-telemetry/
├── dist/        运行的东西（systemd 从这里起）
├── deploy/      本目录 ← deploy.sh 的 SELF_DIR，--check 拿这里的文件比对 /etc
└── package.json
```

```bash
# 开发机
pnpm --filter @mipham/telemetry build
rsync -av --delete \
  --exclude node_modules --exclude coverage --exclude test \
  apps/telemetry/ root@192.144.235.27:/opt/mipham-telemetry/
```

> `--check` 比对的是 `/opt/mipham-telemetry/deploy/nginx/*.conf` 与 `/etc/nginx/sites-available/`。
> 所以**改完配置必须重新 rsync**，否则 `--check` 报的是「主机上的参照过时」而不是漂移 ——
> 两种都会红，但含义不同。

## 上线顺序（三处顺序错了会卡住）

```
0. DNS：log.onemipham.com A 192.144.235.27                        ✅ 已完成
1. 【80-only ACME 块】先装，再签证书
2. certbot certonly --webroot -w /var/www/acme -d log.onemipham.com
3. 【完整 vhost】替换掉引导版
4. Node 22 + systemd unit + keys init + 起服务
5. deploy.sh --check 干净；端到端实发一条
```

### 1. 先装 80-only 的 ACME 块

```bash
sudo bash deploy.sh install --acme
sudo mkdir -p /var/www/acme/.well-known/acme-challenge
printf ok | sudo tee /var/www/acme/.well-known/acme-challenge/probe
curl -sS -H 'Host: log.onemipham.com' \
  http://127.0.0.1/.well-known/acme-challenge/probe    # 必须打印 ok
```

> **探针必须通过再往下走。** 这台机器**没有 `default_server`** ⇒ 默认 server =
> 加载顺序第一个 = `api` 的块。也就是说：**在我们这个块装上去之前，挑战必然落到
> `api` 的 404 上而失败**。原方案把 `certonly` 放在装 vhost 之前，是错的。

### 2. 签证书 —— 用 webroot，**不用 `--nginx`**

```bash
sudo certbot certonly --webroot -w /var/www/acme -d log.onemipham.com
```

`certbot --nginx` 会**改写 vhost**，而 `deploy.sh --check` 建在逐字 diff 上 ——
一改就是永久漂移。用 webroot 则 vhost 完全由我们掌控。

> **遗留差异，必须知道**：另两张证书（api / quant）的 renewal conf 是
> `authenticator = nginx`，**本证书是 `authenticator = webroot`**。
> 将来维护者看到不一致会困惑 —— 原因就是上面这条，不是配置写错了。
> 80 块里的 `location ^~ /.well-known/acme-challenge/` **要长期保留**，
> 无论将来用 webroot 还是换回 nginx 认证器都能续期。

### 3. 换成完整 vhost

```bash
sudo bash deploy.sh install
```

> 反过来先装 443 块会因证书文件不存在而 `nginx -t` 失败（`live/` 里此时只有 api 和 quant）。
> `deploy.sh` 在 `nginx -t` 失败时会**回滚软链并拒绝 reload** —— 同机的 api/quant
> 不会跟着一起 502。

### 4. Node + 密钥 + 起服务

```bash
sudo bash install-node.sh          # → /opt/node/bin/node（版本钉在路径里，可回滚）
sudo bash deploy.sh keys init      # 打印指纹；**绝不可重复执行**
sudo bash deploy.sh install
```

`keys init` 打印的指纹必须等于 journald 里的 `key=` 字段：

```bash
journalctl -u mipham-telemetry -n 1 | grep -o 'key=[0-9a-f]*'
```

**两处不一致 ⇒ 服务读的是另一个密钥文件。** 对不上就别往下走。
**密钥必须备份** —— 丢了它，每一天的聚合文件都再也解不开。

### 5. 验收

```bash
sudo bash deploy.sh --check        # 必须 "no drift"
systemctl is-active mipham-telemetry
journalctl -u mipham-telemetry -n 20
```

## 改动 vhost / unit 之后

**改源头那份，不要手改 `/etc`。** 然后：

```bash
# 开发机：先在本机验证，别拿主机当第一个解析器
bash apps/telemetry/deploy/verify-vhost.sh
# 同步上去
sudo bash deploy.sh install && sudo bash deploy.sh --check
```

`verify-vhost.sh` 会 sed 那份**发行版 vhost**、diff 出来逐行断言「只改了
listen/证书/日志/ACME root/proxy_pass」，再起一个对照 nginx 验 TLS 1.3 强制、
无 3xx、无 `Location`、405 不是 403、413、80 端口 444、日志不含查询串。

> 这个脚本不是锦上添花，它是**唯一**能证伪 `ssl_protocols` 并集语义的东西。
> 那道题的三个「看起来是证明」的检查全是假的：`nginx -t` 只报一句
> `duplicate value "TLSv1.3"` 的警告；配置读起来完全正确；静态 grep 只会看到
> 我们写的那一行。已用「把 include 加回去 ⇒ 必须红」验证过它有施加点。

## 回滚

```bash
# vhost：撤掉软链即可（本目录一域一文件，conf.d/ 是空的）
sudo rm /etc/nginx/sites-enabled/log.onemipham.com.conf
sudo nginx -t && sudo systemctl reload nginx

# 服务
sudo systemctl disable --now mipham-telemetry
# unit 文件不在 /etc/systemd/system 之后记得 daemon-reload

# 数据（谨慎：这会删掉全部聚合）
sudo rm -rf /var/lib/mipham-telemetry
```

证书与 `/var/www/acme` 不必回滚，留着不影响其他站。

## 已知的诚实边界

- **204 不代表已持久化。** 详见 [`../README.md`](../README.md) 的「诚实的边界」
- **`service.lock` 泄漏已修**：读回 pid + `kill(pid,0)` 查存活，持有者已死则回收。
  此前任何启动失败（端口被占、日文件解不开）都会留下陈旧锁，配合
  `Restart=on-failure` 是**不可恢复的重启循环**。修在
  `src/store.ts`，属前置提交，与本目录无关 —— 但排查「服务起不来」时先想到它
- 80 端口的 `return 444` 保证 `http://` 客户端的事件**不送达、不重定向**。
  残余：`return 404`/`444` 都在**读取请求体之前**产生响应，客户端那 64 KiB 里
  可能有少量字节已进内核缓冲。要完全零残余只能 80 不监听 + DNS-01
- 本服务的 443 上**没有 upstream keepalive 池**（有意）：有若干响应不读请求体就发出，
  而 Node 写完响应即销毁那种 socket，放池子会让下一次请求撞上刚被对端关掉的连接 ⇒ 502
