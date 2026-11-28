# Publishing Mipham Code to the VS Code Marketplace

> 维护人操作文档。推荐用**网页上传**（免 PAT / 免 Azure subscription）。

## 前置条件（一次性）

1. **Publisher 必须真实存在**：`package.json` 里的 `publisher: "miphamai"` 必须是
   [VS Code Marketplace](https://marketplace.visualstudio.com/manage) 上真实创建的 publisher。
   - 在 https://marketplace.visualstudio.com/manage → Create publisher，**ID** 填 `miphamai`
     （ID 不可改，Name 随便）。已创建（2026-08-18），勿重复创建。

## 发布步骤（推荐：网页上传，免 PAT）

> ⚠️ `vsce publish` 需要 Azure DevOps PAT，而新建 Azure DevOps 组织现在要求关联
> Azure subscription —— 个人开发者容易被卡。**优先用网页上传，完全绕开 PAT。**

1. **先回填本目录的 `CHANGELOG.md`** —— 它**打进 VSIX**、直接显示在 Marketplace 的
   Changelog 页签。漏掉它就会出现「最新一版的版本说明，内容是上一版的」（2026-09-18 实际发生：
   `package.json` 已 bump 到 0.81.8 而它停在 0.81.7）。
2. bump `package.json` 的 `version`（对齐 CLI 版本）
3. 打包 VSIX：
   ```bash
   cd infrastructure/vscode
   npx vsce package
   ```
4. **验证包内版本**（防打错版本 —— Marketplace 拒重复版本，传错会白跑一趟审核）：
   ```bash
   unzip -p mipham-code-<版本>.vsix extension/package.json | grep -m1 '"version"'
   ```
5. 打开 https://marketplace.visualstudio.com/manage/publishers/miphamai
6. **首次上架**点 **+ New extension** → 选 **Visual Studio Code**（勿选 `vs` / `azure devops`）；
   **后续每个版本**点该扩展行的 **`···` → Update** —— 点 `+ New extension` 会报
   「already exists, use a different name」。两者都上传刚生成的 `.vsix`。

> ⚠️ **上传入口打不开时先分清两种情形**（都以「页面不存在」的样子出现）：
> ① **未登录 / 会话过期** —— 上述 URL 在未登录时一律 302 到
> `app.vssps.visualstudio.com/_signin?reply_to=…`；
> ② 在**没有登录态的浏览器配置档**里打开（如 chrome-devtools MCP 启动的临时 Chrome，
> 它带 `--disable-sync`、无书签无 cookie）—— 会永远被弹回登录页。
> **换真 Chrome 打开再判断「页面在不在」。**

### 上架核验：三个形态（都不需要登录态）

> ⚠️ **上传后立刻查公开 API 很可能仍报旧版本 —— 那是校验窗口，不是失败。**
> 2026-09-19 实测：0.81.9 上传后公开 API 仍报 0.81.8（前一天的版本）。
> **别把「读到旧版本」读成「没传上去」。**

判据是**两个字段一起读**，只看版本号会把「校验中」误读成「没传上去」：

| 形态     | 公开页 `"Version"` | 公开页 `LastUpdatedDateString` | 含义                                  |
| -------- | ------------------ | ------------------------------ | ------------------------------------- |
| ① 未上传 | 旧版本             | **旧时刻**                     | 这一版没到 Marketplace                |
| ② 校验中 | 旧版本             | **新时刻**                     | 上传已收到，正在校验（实测 3–8 分钟） |
| ③ 已发布 | **新版本**         | 新时刻                         | 可安装                                |

0.85.31 实测（2026-11-10）：01:37:59Z 上传 ⇒ 形态②（`Version` 仍 0.85.30、`Last updated`
已是 01:37:59）；01:42:43Z 转形态③（`Version` 0.85.31、`Last updated` 01:42:43），
同时 API 侧 `versions[]` 82 → **83 条**、`flags` = `validated`、`lastUpdated` =
`2026-11-10T01:42:43.173Z` —— 两个探针读的是同一个时刻。

0.85.32 实测（2026-11-10）：13:17:21Z 上传 ⇒ 形态②（`Version` 仍 0.85.31、`Last updated`
已是 13:17:21）；**7.3 分钟时（13:24:39Z）仍是形态②**，用一条全新请求独立复核同样如此
（排除「轮询连接钉在旧 CDN 节点」这一种假象）；13:24:44Z 转形态③（`Version` 0.85.32、
`Last updated` 13:24:44），同时 API 侧 `versions[]` 83 → **84 条**、`flags` = `validated`、
`lastUpdated` = `2026-11-10T13:24:44.597Z` —— 两个探针读的是同一个时刻。**校验窗口 ≈7.4 分钟**
（落到上表 3–8 的上界）。⚠️ 形态② 期间**只有公开页**的 `LastUpdatedDateString` 会跳到上传时刻，
API 的 `versions[0].lastUpdated` 仍指上一版 —— **别拿 API 那个字段判形态②**，两个字段名像、含义不同。

0.85.33 实测（2026-11-13）：13:50:05Z 上传 ⇒ 形态②（`Version` 仍 0.85.32、`Last updated`
已是 13:50:05；此形态在 13:55–13:56 复核三次，API 侧 `versions[]` 始终停在 84 条、`lastUpdated`
仍指 0.85.32 的 `2026-11-10T13:24:44.597Z` —— 再次印证「形态② 别看 API 那个字段」）；13:56:53Z 转形态③
（`Version` 0.85.33、`Last updated` 13:56:53），同时 API 侧 `versions[]` 84 → **85 条**、`flags` = `validated`、
`lastUpdated` = `2026-11-13T13:56:53.757Z` —— 两个探针读的是同一个时刻。**校验窗口 ≈6.8 分钟**（3–8 的中段）。

0.85.36 实测（2026-11-17）：11:58:08Z 上传 ⇒ 形态②（`Version` 仍 0.85.35、`Last updated`
已是 11:58:08；API 侧 `versions[]` 停在 87 条、`versions[0].lastUpdated` 仍指 0.85.35 的
`2026-11-16T11:44:52.523Z`）；12:03:56Z 转形态③（`Version` 0.85.36、`Last updated` 12:03:56、
`PublisherName` = `miphamai`），同时 API 侧 `versions[]` 87 → **88 条**、`flags` = `validated`、
`lastUpdated` = `2026-11-17T12:03:56.073Z` —— 两个探针读的是同一时刻。**校验窗口 ≈5.8 分钟**（3–8 的中段）。

0.85.37 实测（2026-11-19）：01:22:05Z 上传 ⇒ 形态②（`Version` 仍 0.85.36、`Last updated`
已是 01:22:05；API 侧 `versions[]` 停在 88 条、`versions[0].lastUpdated` 仍指 0.85.36 的
`2026-11-17T12:03:56.073Z`）；01:25:43Z 转形态③（`Version` 0.85.37、`Last updated` 01:25:43、
`PublisherName` = `miphamai`），同时 API 侧 `versions[]` 88 → **89 条**、`flags` = `validated`、
`lastUpdated` = `2026-11-19T01:25:43.003Z` —— 两个探针读的是同一时刻。**校验窗口 ≈3.6 分钟**（3–8 的下段）。

0.85.38 实测（2026-11-19）：04:39:16Z 上传 ⇒ 形态②（`Version` 仍 0.85.37、`Last updated`
已是 04:39:16；API 侧 `versions[]` 停在 89 条、`versions[0].lastUpdated` 仍指 0.85.37 的
`2026-11-19T01:25:43.003Z`）；04:47:34Z 转形态③（`Version` 0.85.38、`Last updated` 04:47:34、
`PublisherName` = `miphamai`），同时 API 侧 `versions[]` 89 → **90 条**、`flags` = `validated`、
`lastUpdated` = `2026-11-19T04:47:34.603Z` —— 两个探针读的是同一时刻。**校验窗口 ≈8.3 分钟**（略高于 3–8 的上界）。

0.85.39 实测（2026-11-19）：本次**未观察到形态②** —— 首次探针即形态③（公开页 `Version` 0.85.39、
`Last updated` 10:27:25；API 侧 `versions[]` 90 → **91 条**、`versions[0].flags` = `validated`、
`lastUpdated` = `2026-11-19T10:27:25.93Z`、`PublisherName` = `miphamai`），两个探针读的是同一时刻。
上传时刻未被本方探针捕获 ⇒ **本次不记校验窗口**（形态② 是概率不是必然 —— 上传后首读即 `validated`
的先例已有，别把「没等到翻页」读成「上传失败」）。

0.85.40 实测（2026-11-20）：本次同样**未观察到形态②** —— 首次探针即形态③（公开页 `Version` 0.85.40；
API 侧 `versions[]` 91 → **92 条**、`versions[0].flags` = `validated`、
`lastUpdated` = `2026-11-20T04:37:03.1Z`、`PublisherName` = `miphamai`），两个探针读的是同一时刻。
公开页的 `Last updated` 本次读在另一个节点上（纯文本为空），时刻以 API 的 `lastUpdated` 为准。

0.85.41 实测（2026-11-20）：上传后首次探针（20:33:27 +0800）仍是形态① —— API `versions[]` 92 条、首位停在上一版、`lastUpdated` 仍指上一版的 `2026-11-20T04:37:03.1Z`；20:36:39 读到形态③（`versions[]` 92 → **93 条**、`versions[0].flags` = `validated`、`lastUpdated` = `2026-11-20T12:36:12.12Z`、`PublisherName` = `miphamai`；公开页 `Version` 0.85.41、`LastUpdatedDateString` = `Fri, 20 Nov 2026 12:36:12 GMT` —— 两个探针读的是同一时刻）。**本次未观察到形态②**：校验窗口内只轮询了 API、没有同时打公开页 ⇒「公开页先翻、API 后翻」这一段**未被验证**，别把「没看到」写成「不存在」；上传时刻未被本方探针捕获。

0.85.42 实测（2026-11-22）：上传后**首读即形态③**，本次未观察到形态①/② —— API 侧 `versions[]` 93 → **94 条**、`versions[0].version` = `0.85.42`、`versions[0].flags` = `validated`、`lastUpdated` = `2026-11-22T06:52:10.107Z`、`PublisherName` = `miphamai`、`publisher.flags` = `verified`；`.vsix` **82,439 B** / sha256 `7c829416…` / 包内 version 0.85.42。**不记校验窗口**（窗口是概率不是必然）。

0.85.43 实测（2026-11-22）：`10:37Z` 上传；首读仍是 0.85.42（校验窗口），复读 `versions[]` 94 → **95 条**、`versions[0].version` = `0.85.43`、`flags` = `validated`、`lastUpdated` = `2026-11-22T10:42:49.34Z`；`.vsix` **83,586 B** / sha256 `18cf5064…` / 包内 0.85.43。

0.85.44 实测（2026-11-22）：`.vsix` **84,548 B** / sha256 `a1c5ec4b…` / 9 文件 / 包内 `0.85.44`（20:20 +0800 打包，用户随后网页上传，上传时刻未被探针捕获）。`12:36:27Z` 首读：API `versions[]` **95 条**、首位仍是 `0.85.43`（`lastUpdated 10:42:49.34Z`）、`0.85.44` 未出现 —— **API 侧形态②**（公开页未读，故「公开页先翻」仍未验证）。`12:38:17Z` 转形态③：`versions[]` 95 → **96 条**、`versions[0].version` = `0.85.44`、`flags` = `validated`、`lastUpdated` = `2026-11-22T12:38:17.073Z`、`PublisherName` = `miphamai`。上传时刻未知 ⇒ **不记窗口时长**。

0.85.45 实测（2026-11-24）：`.vsix` **85,188 B** / sha256 `53736df6…` / 9 文件 / 包内 `0.85.45`（用户网页上传）。`07:29:52Z` 首次探到公开页 `LastUpdatedDateString` 已翻到 `Tue, 24 Nov 2026 07:29:52 GMT`，而 `Version` 仍是 `0.85.44`、API `versions[]` 仍 **96 条**、首位 `0.85.44`（`lastUpdated 2026-11-22T12:38:17.073Z`）—— **形态②：上传已登记、校验未完成**。`07:36:50Z` 转形态③：API `versions[]` 96 → **97 条**、`versions[0].version` = `0.85.45`、`flags` = `validated`、`lastUpdated` = `2026-11-24T07:36:39.953Z`；同一时刻公开页 `Version` = `0.85.45`、`LastUpdatedDateString` = `Tue, 24 Nov 2026 07:36:39 GMT`、`PublisherName` = `miphamai`（两个探针读的是同一时刻）。上传时刻未被探针捕获 ⇒ 校验窗口 **≤6 分 47 秒**（`07:29:52Z` 起的上限，不是实测时长）。

0.85.46 实测（2026-11-24）：`.vsix` **86,400 B** / sha256 `5ee37694…` / 9 文件 / 包内 `0.85.46`（用户网页上传）。用户上传后首次探针即**形态③**（本次未观察到形态①/②；上传时刻未被本方探针捕获 ⇒ **不记校验窗口**）：公开页 `Version` = `0.85.46`、`LastUpdatedDateString` = `Tue, 24 Nov 2026 08:49:05 GMT`、`PublisherName` = `miphamai`；API 侧 `versions[]` 97 → **98 条**、`versions[0].version` = `0.85.46`、`flags` = `validated`、`lastUpdated` = `2026-11-24T08:49:05.49Z` —— 两个探针读的是同一时刻。

0.85.48 实测（2026-11-25）：`.vsix` **87,185 B** / sha256 `d86fd4c2…` / 9 文件 / 包内 `0.85.48`（用户网页上传，上传时刻未被探针捕获）。`07:48:46Z` 首读仍是形态①（API `versions[]` **99 条**、首位 `0.85.47`；公开页 `0.85.48` 命中 0）；`07:55:50Z` 复读转形态③：API `versions[]` 99 → **100 条**、`versions[0].version` = `0.85.48`、`flags` = `validated`、`lastUpdated` = `2026-11-25T07:55:02.857Z`；同一时刻公开页（cache-bust）`0.85.48` 命中 **6** 次、内嵌 `"version":"0.85.48"` ⇒ 首个探针到生效 **≤ ≈7 分钟**（上传时刻未捕获，是上限不是实测时长）。
0.85.49 实测（2026-11-26）：`.vsix` **87,919 B** / sha256 `f358b588…` / 9 文件 / 包内 `0.85.49`（用户网页上传，上传时刻未被探针捕获）。`03:16:46Z` 首读即**形态②：上传已登记、校验未完成** —— 公开页 `LastUpdatedDateString` 已翻到 `Thu, 26 Nov 2026 03:15:55 GMT`，而 `Version` 仍 `0.85.48`（`0.85.49` 命中 0）、API `versions[]` 仍 **100 条**、首位 `0.85.48`（`lastUpdated 2026-11-25T07:55:02.857Z`）。按 25–30 秒轮询 API：`03:21:35Z` 仍 100 条；`03:22:03Z` 转**形态③**：`versions[]` 100 → **101 条**、`versions[0].version` = `0.85.49`、`flags` = `validated`、`lastUpdated` = `2026-11-26T03:21:36.037Z`；同一时刻公开页（cache-bust）`Version` = `0.85.49`、`LastUpdatedDateString` = `Thu, 26 Nov 2026 03:21:36 GMT`、`0.85.49` 命中 **6** 次、内嵌 `"version":"0.85.49"`、`PublisherName` = `miphamai`（两个探针读的是同一时刻）。上传时刻未捕获 ⇒ 校验窗口 **≤5 分 41 秒**（`03:15:55Z` 起的上限，不是实测时长）。
0.85.50 实测（2026-11-26）：`.vsix` **88,535 B** / sha256 `fa18c3ec…` / 9 文件 / 包内 `0.85.50`（20:56 +0800 本地 `npx @vscode/vsce package` 打包，9 文件 198,190 B 解包清单；用户网页上传，上传时刻未被探针捕获）。`13:04:07Z` **首个探针即形态③（两读同刻一致）**：公开页（cache-bust）`Version` = `0.85.50`、`LastUpdatedDateString` = `Thu, 26 Nov 2026 13:00:53 GMT`、`0.85.50` 命中 **6** 次、内嵌 `"version":"0.85.50"`、`PublisherName` = `miphamai`（`verified`）；同刻 API `versions[]` 101 → **102 条**、`versions[0].version` = `0.85.50`、`flags` = `validated`、`lastUpdated` = `2026-11-26T13:00:53.197Z`。上传时刻未捕获 ⇒ **不记校验窗口**（首个探针到生效的时长不可测，不写成上限冒充实测）。
0.85.51 实测（2026-11-28）：`.vsix` **88,989 B** / sha256 `ef82e78b…` / 9 文件 / 包内 `0.85.51`（本地 `npx --no-install @vscode/vsce package` 打包，9 文件解包清单 199,745 B；内层 `changelog.md` 与 `infrastructure/vscode/CHANGELOG.md` 逐字节相同）。`05:32Z` 探针仍**形态①**（API `versions[]` **102 条**、首位 `0.85.50`）；用户网页上传后 `05:43:33Z` 双探针**形态③（同刻一致）**：API `versions[]` 102 → **103 条**、`versions[0].version` = `0.85.51`、`flags` = `validated`、`lastUpdated` = `2026-11-28T05:36:01.653Z`、`publisher` = `miphamai`（`verified`）；公开页（cache-bust）`Version` = `0.85.51`、`LastUpdatedDateString` = `Sat, 28 Nov 2026 05:36:01 GMT`、`0.85.51` 命中 **6** 次、内嵌 `"version":"0.85.51"`。上传时刻未被探针捕获 ⇒ **不记校验窗口**；`05:32Z` → 翻页 **≤ ≈4 分钟**（`05:36:01Z` 起算的上限，不是实测时长）。

0.85.52 实测（2026-11-28）：`.vsix` **89,317 B** / sha256 `994659ff…` / 9 文件 / 包内 `0.85.52`（本地 `npx --no-install @vscode/vsce package` 打包，9 文件解包清单 200,073 B）。本轮为**DeepSeek 正式模型名对齐**（`deepseek-flash` 成为正式 id 与默认模型），扩展本体是薄启动器、包内只随版本号变化。`06:22:19Z` 首读为**形态②：上传已登记、校验未完成** —— 公开页（cache-bust）`LastUpdatedDateString` 已跳到 `Sat, 28 Nov 2026 06:21:52 GMT`（= 上传登记时刻），而 `Version` 仍 `0.85.51`（`0.85.52` 命中 0）、API `versions[]` 仍 **103 条**、首位 `0.85.51`。按 30 秒轮询 API：`06:25:55Z` 转**形态③** —— `versions[]` 103 → **104 条**、`versions[0].version` = `0.85.52`、`flags` = `validated`、`lastUpdated` = `2026-11-28T06:25:29.7Z`；同一时刻公开页（cache-bust）`Version` = `0.85.52`、`LastUpdatedDateString` = `Sat, 28 Nov 2026 06:25:29 GMT`、`0.85.52` 命中 **6** 次、内嵌 `"version":"0.85.52"`、`PublisherName` = `miphamai`（两个探针读的是同一时刻）。**校验窗口 ≈3 分 38 秒**（起点是公开页登记的 `06:21:52Z`，不是点击上传的时刻）。

0.85.53 实测（2026-11-28）：`.vsix` **90,006 B** / sha256 `002016e0…` / 9 文件 / 包内 `0.85.53`（本地 `npx --no-install @vscode/vsce package` 打包，9 文件解包清单 203,321 B；内层 `changelog.md` 与 `infrastructure/vscode/CHANGELOG.md` 逐字节相同）。本轮为 **CC slash command 能力级对齐**（6 个能力命令 + 3 个兼容别名，141 → 150），扩展本体是薄启动器、包内只随版本号变化。用户网页上传后，`07:39:08Z` 首读为**形态②：上传已登记、校验未完成** —— 公开页（cache-bust）`LastUpdatedDateString` 已跳到 `Sat, 28 Nov 2026 07:39:08 GMT`，而 `Version` 仍 `0.85.52`（`0.85.53` 命中 0）、API `versions[]` 仍 **104 条**、首位 `0.85.52`（`lastUpdated` = `2026-11-28T06:25:29.7Z`）。按 30 秒轮询 API：`07:45:56Z` 转**形态③（两读同刻一致）** —— `versions[]` 104 → **105 条**、`versions[0].version` = `0.85.53`、`flags` = `validated`、`lastUpdated` = `2026-11-28T07:45:56.153Z`、`publisher` = `miphamai`；公开页（cache-bust）`Version` = `0.85.53`、`LastUpdatedDateString` = `Sat, 28 Nov 2026 07:45:56 GMT`、`0.85.53` 命中 **6** 次、内嵌 `"version":"0.85.53"`。**校验窗口 ≈6 分 48 秒**（起点是公开页登记的 `07:39:08Z`，不是点击上传的时刻）。

```bash
# A. 公开页（必须 cache-bust，CDN 会给旧读数）
curl -4 -sS -H 'Cache-Control: no-cache' \
  "https://marketplace.visualstudio.com/items?itemName=miphamai.mipham-code&cb=$(date +%s%N)" \
  | grep -o '"Version":"[^"]*"\|LastUpdatedDateString":"[^"]*"' | head -2

# B. 页内同源 extensionquery —— flags 必须带 63（含 0x200）
#    flags 含 0x200 时 versions[] 只回「已通过校验」的版本 ⇒ 校验期间它停在旧版是正常的，
#    别据此判定上传失败；上传成功的旁证是 versions[] 的条数在转 ③ 时恰好 +1。
curl -4 -sS -X POST \
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?cb=$(date +%s)" \
  -H 'Content-Type: application/json' -H 'Accept: application/json;api-version=7.2-preview.1' \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"miphamai.mipham-code"}],"pageNumber":1,"pageSize":1,"sortBy":0,"sortOrder":0}],"assetTypes":[],"flags":63}'
```

> ⚠️ **通道会变**：曾出现 `curl` 走 IPv6 被 reset（HTTP 000）而页面本身 200 —— 加 `-4` 即通；
> 也有过直连被墙、只能走浏览器 CDP 的时段。**先用无关站点验通道，再判目标**。
> 登录态 publisher 页上的版本徽章能看到「验证中 / 已通过」字样，仍是最权威的读数，
> 但**它不再是唯一判据**。

## 发布步骤（备选：命令行 vsce，需要 PAT）

```bash
cd infrastructure/vscode
npx vsce login miphamai        # 交互式粘贴 Azure DevOps PAT
npx vsce publish --packagePath mipham-code-<版本>.vsix
```

PAT 生成：https://dev.azure.com/ → 头像 → Personal Access Tokens → scope 勾
**Marketplace → Manage**。（若新建组织要求 Azure subscription，改用上面的网页上传。）

## 关键约束

- **版本必须递增**：Marketplace 不接受与已发布版本重复的 version。每次发布前先在
  `package.json` 里 bump `version`（对齐 CLI 版本）。
- **`.vsix` 是构建产物**，不要提交到 git（已加入 `.gitignore`）。
- **图标必须是真 PNG**：`icon.png` 需为 128×128 真 PNG（Marketplace 拒绝 JPEG 改名；
  2026-08-18 已用 `sips -s format png` 修复）。
- **验证打包**：发布前先 `npx vsce package` 确认构建通过，再 `npx vsce ls` 检查
  内容包含 `LICENSE`、`extension.js`、`package.json`、`README.md`。
- **打进包内的文档会漏出同步清单**：改版本号时问「**哪些文件会进这个包**」（`npx vsce ls`）。
  实测 0.81.9 包内含 9 项，其中 `extension/changelog.md` 与 `extension/PUBLISH.md`
  **都在**（`.vscodeignore` 不排除它们）—— 前者显示在 Marketplace 页签上，
  后者是这份内部手册本身。`bump-version.sh` 的版本一致性清单**不包括**产物内文档。

## 上架后

- 更新 `README.md` 的 Marketplace 段为正式链接
  `https://marketplace.visualstudio.com/items?itemName=miphamai.mipham-code`。
