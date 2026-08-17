# Publishing Mipham Code to the VS Code Marketplace

> 维护人操作文档。发布前请先确认已满足前置条件。

## 前置条件（一次性）

1. **Publisher 必须真实存在**：`package.json` 里的 `publisher: "miphamai"` 必须是
   [VS Code Marketplace](https://marketplace.visualstudio.com/manage) 上真实创建的
   publisher，否则 `vsce publish` 会报 `publisher not found`。
   - 在 https://marketplace.visualstudio.com/manage → Create publisher，名称填 `miphamai`。
2. **PAT（Personal Access Token）**：Azure DevOps 个人令牌，scope 勾选 **Marketplace → Manage**。
   - 生成处：https://dev.azure.com/ → 右上角头像 → Personal Access Tokens。
   - 令牌只用于 `vsce login`，不要提交到仓库。

## 发布步骤

```bash
cd infrastructure/vscode

# 1. 登录 publisher（粘贴 PAT，交互式）
npx vsce login miphamai

# 2a. 发布预构建的 VSIX（最直接，跳过重新打包）
npx vsce publish --packagePath mipham-code-0.44.0.vsix

# 2b. 或重新打包并发布
npx vsce package
npx vsce publish
```

## 关键约束

- **版本必须递增**：Marketplace 不接受与已发布版本重复的 version。每次发布前先在
  `package.json` 里 bump `version`（可参考 CLI 版本对齐，当前 CLI 0.44.0）。
- **`.vsix` 是构建产物**，不要提交到 git（已加入 `.gitignore`）。
- **验证打包**：发布前先 `npx vsce package` 确认构建通过，再 `npx vsce ls` 检查
  内容包含 `LICENSE`、`extension.js`、`package.json`、`README.md`。

## 上架后

- 更新 `README.md` 里 "From VS Code Marketplace _(coming soon)_" 段为正式链接
  `https://marketplace.visualstudio.com/items?itemName=miphamai.mipham-code`。
