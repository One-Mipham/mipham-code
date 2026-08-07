# JetBrains 全平台插件 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 JetBrains IDE 家族创建 Mipham Code 插件，对标 VS Code 扩展，用户在 IDE 内置 Terminal 中一键启动 mipham。

**Architecture:** 单文件 Kotlin Action + Gradle 构建 + plugin.xml 配置。3 个 Action（Start/Focus/OpenConfig），快捷键 Cmd+Esc / Cmd+Shift+M，IDE Settings 3 个配置项。全平台兼容所有 JetBrains IDE。

**Tech Stack:** Kotlin 1.9+, IntelliJ Platform SDK 2024.3+, Gradle 8.x with `org.jetbrains.intellij` plugin

## Global Constraints

- 功能对标 `infrastructure/vscode/extension.js` — 3 个 action + 2 个 keybinding + 3 个 config
- 快捷键：`Cmd+Esc` (启动), `Cmd+Shift+M` (聚焦)
- 兼容所有 JetBrains IDE（`com.intellij.modules.platform`）
- 版本号 0.21.0，与 CLI 一致
- 发布 artifact: `.zip` 包含 `.jar`，用户 Settings → Plugins → Install from Disk
- 构建命令: `./gradlew buildPlugin`
- 无需外部依赖（仅 IntelliJ Platform SDK）

---

## File Structure

```
infrastructure/jetbrains/           ← NEW directory
├── build.gradle.kts                ← CREATE: Gradle build with intellij plugin
├── gradle.properties               ← CREATE: plugin version + platform version
├── settings.gradle.kts             ← CREATE: project name
├── gradlew                         ← CREATE: Gradle wrapper script (generated)
└── src/main/
    ├── kotlin/com/miphamai/plugin/
    │   └── MiphamAction.kt         ← CREATE: single Action class (~80 lines)
    └── resources/META-INF/
        └── plugin.xml              ← CREATE: plugin descriptor (~70 lines)
```

---

### Task 1: Gradle 构建骨架

**Files:**

- Create: `infrastructure/jetbrains/settings.gradle.kts`
- Create: `infrastructure/jetbrains/gradle.properties`
- Create: `infrastructure/jetbrains/build.gradle.kts`
- Create: `infrastructure/jetbrains/src/main/resources/META-INF/plugin.xml`

**Interfaces:**

- Produces: Gradle project that compiles with `./gradlew buildPlugin`
- Produces: `plugin.xml` defining project id `ai.mipham.code`, name "Mipham Code", version 0.21.0

- [ ] **Step 1: Create settings.gradle.kts**

```kotlin
// infrastructure/jetbrains/settings.gradle.kts
rootProject.name = "mipham-code-jetbrains"
```

- [ ] **Step 2: Create gradle.properties**

```properties
# infrastructure/jetbrains/gradle.properties
pluginVersion = 0.21.0
platformVersion = 2024.3
platformPlugins = com.intellij.modules.platform
```

- [ ] **Step 3: Create build.gradle.kts**

```kotlin
// infrastructure/jetbrains/build.gradle.kts
plugins {
    id("java")
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "ai.mipham"
version = project.property("pluginVersion").toString()

repositories {
    mavenCentral()
}

intellij {
    version.set(project.property("platformVersion").toString())
    plugins.set(listOf("com.intellij.modules.platform"))
}

tasks {
    patchPluginXml {
        sinceBuild.set("243")
        untilBuild.set("")
    }
}
```

- [ ] **Step 4: Create plugin.xml 骨架（无 actions，先验证构建）**

```xml
<!-- infrastructure/jetbrains/src/main/resources/META-INF/plugin.xml -->
<idea-plugin>
    <id>ai.mipham.code</id>
    <name>Mipham Code</name>
    <vendor url="https://mipham.ai">MiphamAI</vendor>

    <description><![CDATA[
        Multi-model AI coding terminal for JetBrains IDEs.
        Open-source, 7 providers, 30 tools, background agents, plan mode.
    ]]></description>

    <depends>com.intellij.modules.platform</depends>

    <!-- Actions registered in Task 2 -->
    <!-- Configuration registered in Task 3 -->

    <extensions defaultExtensionNs="com.intellij">
    </extensions>
</idea-plugin>
```

- [ ] **Step 5: Initialize Gradle wrapper**

```bash
cd infrastructure/jetbrains && gradle wrapper --gradle-version 8.10
```

Expected: `gradlew` and `gradlew.bat` created, `gradle/wrapper/` directory populated.

- [ ] **Step 6: Verify build compiles（空插件）**

```bash
cd infrastructure/jetbrains && ./gradlew buildPlugin
```

Expected: BUILD SUCCESSFUL, output `build/distributions/mipham-code-jetbrains-0.21.0.zip`

- [ ] **Step 7: Commit**

```bash
git add infrastructure/jetbrains/
git commit -m "feat(jetbrains): add Gradle build skeleton with plugin.xml

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: MiphamAction.kt — 启动 + 聚焦

**Files:**

- Create: `infrastructure/jetbrains/src/main/kotlin/com/miphamai/plugin/MiphamAction.kt`
- Modify: `infrastructure/jetbrains/src/main/resources/META-INF/plugin.xml` — register actions

**Interfaces:**

- Consumes: `plugin.xml` from Task 1
- Produces: `MiphamStartAction`, `MiphamFocusAction`, `MiphamOpenConfigAction` — 3 AnAction classes
- Produces: Keybindings `Cmd+Esc` (start), `Cmd+Shift+M` (focus)

- [ ] **Step 1: Write MiphamAction.kt**

```kotlin
// infrastructure/jetbrains/src/main/kotlin/com/miphamai/plugin/MiphamAction.kt
package com.miphamai.plugin

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.terminal.JBTerminalWidget
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.ProjectManager
import org.jetbrains.plugins.terminal.AbstractTerminalRunner
import org.jetbrains.plugins.terminal.TerminalToolWindowFactory
import org.jetbrains.plugins.terminal.TerminalView
import java.util.*

private const val MIPHAM_COMMAND = "mipham"
private const val TERMINAL_TITLE = "Mipham Code"

/**
 * Start: open a Terminal tab and run `mipham`.
 * If a Mipham terminal already exists, reuse it.
 */
class MiphamStartAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val terminalView = TerminalView.getInstance(project)

        // Check for existing mipham terminal
        val existing = findMiphamTerminal(terminalView)
        if (existing != null) {
            terminalView.openTerminalIn(existing)
            return
        }

        // Create new terminal tab running mipham
        val widget = terminalView.createLocalShellWidget(project.basePath ?: "", TERMINAL_TITLE)
        widget.executeCommand(MIPHAM_COMMAND)
    }
}

/**
 * Focus: bring the first Mipham terminal tab to front.
 */
class MiphamFocusAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val terminalView = TerminalView.getInstance(project)
        val existing = findMiphamTerminal(terminalView)
        if (existing != null) {
            terminalView.openTerminalIn(existing)
        } else {
            // No mipham terminal — start one
            MiphamStartAction().actionPerformed(e)
        }
    }
}

/**
 * OpenConfig: open Settings → Tools → Mipham Code.
 */
class MiphamOpenConfigAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ShowSettingsUtil.getInstance().showSettingsDialog(project, "Mipham Code")
    }
}

/**
 * Find a terminal widget whose title equals TERMINAL_TITLE.
 */
private fun findMiphamTerminal(terminalView: TerminalView): JBTerminalWidget? {
    // Iterate over open terminal tabs, return the one with our title
    val terminals = terminalView.getWidgets()
    return terminals.find { widget ->
        widget.toString().contains(TERMINAL_TITLE)
    }
}
```

- [ ] **Step 2: Register actions in plugin.xml**

Replace the `<actions>` comment in plugin.xml with:

```xml
    <actions>
        <action id="MiphamCode.Start"
                class="com.miphamai.plugin.MiphamStartAction"
                text="Mipham Code: Start"
                description="Open Mipham Code in a Terminal tab">
            <add-to-group group-id="ToolsMenu" anchor="last"/>
            <keyboard-shortcut keymap="$default" first-keystroke="meta ESCAPE"/>
        </action>

        <action id="MiphamCode.Focus"
                class="com.miphamai.plugin.MiphamFocusAction"
                text="Mipham Code: Focus Terminal"
                description="Switch to the Mipham Code terminal tab">
            <add-to-group group-id="ToolsMenu" anchor="last"/>
            <keyboard-shortcut keymap="$default" first-keystroke="meta shift M"/>
        </action>

        <action id="MiphamCode.OpenConfig"
                class="com.miphamai.plugin.MiphamOpenConfigAction"
                text="Mipham Code: Open Settings"
                description="Open Mipham Code plugin settings">
            <add-to-group group-id="ToolsMenu" anchor="last"/>
        </action>
    </actions>
```

- [ ] **Step 3: Build and verify**

```bash
cd infrastructure/jetbrains && ./gradlew buildPlugin
```

Expected: BUILD SUCCESSFUL. Verify `build/distributions/` contains the .zip.

- [ ] **Step 4: Commit**

```bash
git add infrastructure/jetbrains/src/ infrastructure/jetbrains/build.gradle.kts
git commit -m "feat(jetbrains): add Start/Focus/OpenConfig actions with keybindings

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 配置项 + CHANGELOG

**Files:**

- Modify: `infrastructure/jetbrains/src/main/resources/META-INF/plugin.xml` — add config properties
- Create: `infrastructure/jetbrains/CHANGELOG.md`

**Interfaces:**

- Consumes: plugin.xml from Task 2, MiphamAction.kt actions
- Produces: 3 IDE Settings properties (bunPath, provider, model)

- [ ] **Step 1: Add configuration to plugin.xml**

Insert inside `<extensions defaultExtensionNs="com.intellij">`:

```xml
        <applicationConfigurable
            id="mipham.code.settings"
            displayName="Mipham Code"
            instance="com.miphamai.plugin.MiphamSettingsConfigurable"/>

        <applicationService
            serviceImplementation="com.miphamai.plugin.MiphamSettings"/>
```

Add after `</extensions>` but before `</idea-plugin>`:

```xml
    <projectListeners>
        <listener class="com.miphamai.plugin.MiphamStartupListener"
                  topic="com.intellij.openapi.project.ProjectManagerListener"/>
    </projectListeners>
```

- [ ] **Step 2: Add MiphamSettings + Configurable to MiphamAction.kt**

Append to `MiphamAction.kt`:

```kotlin
import com.intellij.openapi.components.*
import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Persistent settings stored in IDE config directory.
 */
@State(
    name = "MiphamCodeSettings",
    storages = [Storage("mipham-code.xml")]
)
class MiphamSettings : PersistentStateComponent<MiphamSettings.State> {
    data class State(
        var bunPath: String = "",
        var provider: String = "",
        var model: String = ""
    )

    private var myState = State()

    override fun getState(): State = myState

    override fun loadState(state: State) {
        myState = state
    }

    companion object {
        fun getInstance(): MiphamSettings =
            com.intellij.openapi.application.ApplicationManager.getApplication()
                .getService(MiphamSettings::class.java)
    }
}

/**
 * Settings UI panel: Tools → Mipham Code.
 */
class MiphamSettingsConfigurable : Configurable {
    private var bunPathField = JBTextField()
    private var providerField = JBTextField()
    private var modelField = JBTextField()
    private var panel: JPanel? = null

    override fun getDisplayName(): String = "Mipham Code"

    override fun createComponent(): JComponent {
        panel = FormBuilder.createFormBuilder()
            .addLabeledComponent("Bun path (empty = auto-detect):", bunPathField)
            .addLabeledComponent("Default provider:", providerField)
            .addLabeledComponent("Default model:", modelField)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        return panel!!
    }

    override fun isModified(): Boolean {
        val settings = MiphamSettings.getInstance().state
        return bunPathField.text != settings.bunPath
                || providerField.text != settings.provider
                || modelField.text != settings.model
    }

    override fun apply() {
        val settings = MiphamSettings.getInstance()
        settings.state = MiphamSettings.State(
            bunPath = bunPathField.text,
            provider = providerField.text,
            model = modelField.text
        )
    }

    override fun reset() {
        val settings = MiphamSettings.getInstance().state
        bunPathField.text = settings.bunPath
        providerField.text = settings.provider
        modelField.text = settings.model
    }
}
```

- [ ] **Step 3: Add startup listener (optional — show notification on first launch)**

Append to `MiphamAction.kt`:

```kotlin
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.ProjectManagerListener

/**
 * Show a one-time notification when a project opens, reminding about the plugin.
 */
class MiphamStartupListener : ProjectManagerListener {
    override fun projectOpened(project: com.intellij.openapi.project.Project) {
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup("Mipham Code")
            .createNotification(
                "Mipham Code is ready. Press Cmd+Esc to start.",
                NotificationType.INFORMATION
            )
        notification.notify(project)
    }
}
```

And add to plugin.xml inside `<extensions>`:

```xml
        <notificationGroup id="Mipham Code"
            displayType="BALLOON"
            isLogByDefault="false"/>
```

- [ ] **Step 4: Create CHANGELOG.md**

```markdown
# Mipham Code — JetBrains Plugin Changelog

## 0.21.0 (2026-08-07)

- Initial release
- Start Mipham Code in IDE Terminal (`Cmd+Esc`)
- Focus existing Mipham terminal (`Cmd+Shift+M`)
- Open plugin settings (`Tools → Mipham Code: Open Settings`)
- Configurable: bun path, default provider, default model
- Compatible with IntelliJ IDEA, WebStorm, PyCharm, GoLand, Rider, CLion, DataGrip
```

- [ ] **Step 5: Build final .zip**

```bash
cd infrastructure/jetbrains && ./gradlew buildPlugin
```

Expected: BUILD SUCCESSFUL. `build/distributions/mipham-code-jetbrains-0.21.0.zip` ready.

- [ ] **Step 6: Commit**

```bash
git add infrastructure/jetbrains/src/ infrastructure/jetbrains/src/main/resources/META-INF/plugin.xml infrastructure/jetbrains/CHANGELOG.md
git commit -m "feat(jetbrains): add settings UI, startup notification, CHANGELOG

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: README + 最终验证

**Files:**

- Create: `infrastructure/jetbrains/README.md`

- [ ] **Step 1: Create README.md**

````markdown
# Mipham Code — JetBrains Plugin

Multi-model AI coding terminal for all JetBrains IDEs.

## Install

1. Download `mipham-code-jetbrains-0.21.0.zip` from [releases](https://github.com/One-Mipham/mipham-code/releases)
2. In your IDE: **Settings → Plugins → ⚙️ → Install Plugin from Disk**
3. Select the `.zip` file
4. Restart IDE

## Usage

| Action            | Shortcut      | Menu                                |
| ----------------- | ------------- | ----------------------------------- |
| Start Mipham Code | `Cmd+Esc`     | Tools → Mipham Code: Start          |
| Focus Terminal    | `Cmd+Shift+M` | Tools → Mipham Code: Focus Terminal |
| Open Settings     | —             | Tools → Mipham Code: Open Settings  |

## Settings

**Settings → Tools → Mipham Code**

| Setting          | Default  | Description                                    |
| ---------------- | -------- | ---------------------------------------------- |
| Bun path         | _(auto)_ | Path to `bun` executable                       |
| Default provider | _(none)_ | Provider ID (deepseek, anthropic, openai, ...) |
| Default model    | _(none)_ | Model ID                                       |

## Requirements

- IntelliJ IDEA 2024.3+ (or WebStorm/PyCharm/GoLand/Rider/CLion/DataGrip)
- [Mipham Code CLI](https://mipham.ai/code) installed (`mipham` on PATH)

## Build from Source

```bash
cd infrastructure/jetbrains
./gradlew buildPlugin
# Output: build/distributions/mipham-code-jetbrains-0.21.0.zip
```
````

````

- [ ] **Step 2: Final build verification**

```bash
cd infrastructure/jetbrains && ./gradlew clean buildPlugin
ls -la build/distributions/
````

Expected: `.zip` artifact present and non-empty.

- [ ] **Step 3: Commit**

```bash
git add infrastructure/jetbrains/README.md
git commit -m "docs(jetbrains): add README with install and usage instructions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 修订历史

| 版本  | 日期       | 变更内容                                         | 维护人     |
| ----- | ---------- | ------------------------------------------------ | ---------- |
| 1.0.0 | 2026-08-07 | 初版：4 tasks，Gradle + Kotlin Action + Settings | 技术委员会 |
