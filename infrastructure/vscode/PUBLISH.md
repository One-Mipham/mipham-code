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
