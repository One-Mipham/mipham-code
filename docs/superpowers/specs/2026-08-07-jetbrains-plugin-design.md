# Mipham Code — JetBrains 全平台插件 设计 Spec

> **版本**: 1.0.0
> **日期**: 2026-08-07
> **阶段**: 生态扩展 — JetBrains IDE 插件
> **维护人**: One Mipham Corporation 技术委员会

---

## 一、目标

为 JetBrains IDE 家族创建 Mipham Code 插件，功能对标 VS Code 扩展。用户在 IDE 内一键启动 Mipham Code 终端，无需离开 IDE。

---

## 二、设计方案

**方式 A — Terminal 启动**：插件在 IDE 内置 Terminal 中执行 `mipham` 命令。零依赖，单文件 Kotlin。

### 2.1 文件结构

```
infrastructure/jetbrains/
├── build.gradle.kts               # Gradle 构建（生成 .jar）
├── gradle.properties              # IntelliJ Platform 版本 + 插件版本
├── settings.gradle.kts            # 项目名
├── src/main/resources/
│   └── META-INF/
│       └── plugin.xml             # 插件描述 + actions + keybindings + config
└── src/main/kotlin/com/miphamai/plugin/
    └── MiphamAction.kt            # 启动 mipham 的 Action（~80 行）
```

### 2.2 构建与分发

- 构建命令：`./gradlew buildPlugin` → 输出 `build/distributions/mipham-code-0.21.0.zip`（内含 .jar）
- 安装方式：Settings → Plugins → ⚙️ → Install Plugin from Disk → 选择 .zip
- 最终目标：上传 JetBrains Marketplace，用户直接在 IDE 内搜索安装

### 2.2 功能对标 VS Code 扩展

| 功能 | VS Code | JetBrains |
|------|---------|-----------|
| 启动 Mipham Code | `mipham-code.start` | `MiphamCode.Start` |
| 聚焦终端 | `mipham-code.focus` | `MiphamCode.Focus` |
| 打开配置 | `mipham-code.openConfig` | `MiphamCode.OpenConfig` |
| 快捷键-启动 | `Cmd+Esc` | `Cmd+Esc` |
| 快捷键-聚焦 | `Cmd+Shift+M` | `Cmd+Shift+M` |

### 2.3 配置项（Settings → Tools → Mipham Code）

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mipham-code.bunPath` | string | `""` | bun 路径，空则自动检测 |
| `mipham-code.provider` | string | `""` | 默认 provider |
| `mipham-code.model` | string | `""` | 默认 model |

### 2.4 IDE 兼容列表

```xml
<depends>com.intellij.modules.platform</depends>
<!-- 全平台兼容：IDEA Ultimate/Community、WebStorm、PyCharm、GoLand、Rider、CLion、DataGrip -->
```

不声明具体产品依赖，使用 `com.intellij.modules.platform` 即可覆盖所有 JetBrains IDE。

### 2.5 MiphamAction.kt 核心逻辑

```kotlin
class MiphamAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        // 1. 查找已存在的 mipham 终端
        // 2. 如无，创建新 Terminal 标签执行 "mipham"
        // 3. 聚焦该终端
    }
}
```

约 80 行 Kotlin。使用 IntelliJ Platform API 的 `TerminalToolWindowManager`。

---

## 三、不做

- ❌ 不做独立 Tool Window 面板（保持 Terminal 方式，与 VS Code 一致）
- ❌ 不做 JetBrains Marketplace 自动发布（CI 手动触发）
- ❌ 不做 MCP/OAuth UI 集成（Terminal 内已有）

---

## 四、测试

- 手动测试：在 IntelliJ IDEA Community 2024.3+ 中安装插件，验证三个 action
- 验证点：Terminal 正常启动 mipham、快捷键响应、配置项生效

---

### 修订历史

| 版本 | 日期 | 变更内容 | 维护人 |
|------|------|---------|--------|
| 1.0.0 | 2026-08-07 | 初版 | 技术委员会 |
