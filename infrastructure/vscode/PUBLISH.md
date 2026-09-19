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

> ⚠️ **上传后立刻查公开 API 很可能仍报旧版本 —— 那是验证/传播窗口，不是失败。**
> Marketplace 的公开 Gallery API **读不出「验证中」这个状态**，唯一判据是**登录态**
> publisher 页上的版本状态徽章。2026-09-19 实测：0.81.9 上传后公开 API 仍报 0.81.8
> （前一天的版本）。**别把「读到旧版本」读成「没传上去」。**

## 发布步骤（备选：命令行 vsce，需要 PAT）

```bash
cd infrastructure/vscode
npx vsce login miphamai        # 交互式粘贴 Azure DevOps PAT
npx vsce publish --packagePath mipham-code-0.48.0.vsix
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
