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

1. bump `package.json` 的 `version`（对齐 CLI 版本）
2. 打包 VSIX：
   ```bash
   cd infrastructure/vscode
   npx vsce package
   ```
3. 打开 https://marketplace.visualstudio.com/manage/publishers/miphamai
4. 点 **+ New extension** → 选 **Visual Studio Code**（勿选 `vs` / `azure devops`）→
   上传生成的 `.vsix`

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

## 上架后

- 更新 `README.md` 的 Marketplace 段为正式链接
  `https://marketplace.visualstudio.com/items?itemName=miphamai.mipham-code`。
