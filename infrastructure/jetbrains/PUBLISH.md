# Publishing Mipham Code to the JetBrains Marketplace

> 维护人操作文档。发布前请先确认已满足前置条件。

## 前置条件（一次性）

1. **JetBrains Account**：用**现有** JetBrains 账号（下载 PyCharm 那个）登录
   https://plugins.jetbrains.com/author/me，**不用新建账号**。
   - Vendor 类型选 **Organization**，vendor ID = `miphamai`，公司名 = `One Mipham Corporation`。
   - ⚠️ vendor ID 一旦创建**不可改**，务必确认拼写。
2. **License**：Apache-2.0（已随仓库提供 `LICENSE`）。
3. **Marketplace Token**：https://plugins.jetbrains.com/author/me/tokens 生成 token。
   - 令牌只通过环境变量注入，**绝不写进代码或提交到仓库**（已接入 `build.gradle.kts`）。

## 首次发布（需先注册插件清单）

第一次上架前，插件 ID `ai.mipham.code` 必须在 Marketplace 上**手动创建 listing**：

1. 登录 https://plugins.jetbrains.com/plugin/me
2. **Add new plugin** → 填写名称 `Mipham Code`、ID `ai.mipham.code`、category、license（Apache-2.0）
3. 提交后等平台审核通过

之后每次发新版本即可用 gradle 直接上传。

## 发布步骤

```bash
cd infrastructure/jetbrains

# 1. 注入 token（环境变量，不落盘）
export JETBRAINS_MARKETPLACE_TOKEN="<你的 token>"

# 2. 构建 + 上传
./gradlew buildPlugin publishPlugin
```

## 关键约束

- **版本必须递增**：改 `gradle.properties` 的 `pluginVersion`（当前 0.44.3）。
  Marketplace 拒绝重复版本。
- **`build/` 和 `.gradle/` 是构建产物**，已在 `.gitignore` 排除，不要提交。
- **本地验证**：发布前先 `./gradlew buildPlugin`，产物在
  `build/distributions/mipham-code-jetbrains-0.44.3.zip`，可在 IDE 里
  **Settings → Plugins → ⚙️ → Install Plugin from Disk** 安装自测。

## 上架后

- 更新 `README.md` 的 Install 段，从「Download from releases」改为 Marketplace 链接
  `https://plugins.jetbrains.com/plugin/<pluginId>`。
