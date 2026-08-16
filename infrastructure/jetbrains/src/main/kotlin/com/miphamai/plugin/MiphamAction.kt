package com.miphamai.plugin

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManagerListener
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import org.jetbrains.plugins.terminal.TerminalView
import javax.swing.JComponent
import javax.swing.JPanel

private const val MIPHAM_COMMAND = "mipham"
private const val TERMINAL_TITLE = "Mipham Code"

/**
 * Start: open a Terminal tab and run `mipham`.
 */
class MiphamStartAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val terminalView = TerminalView.getInstance(project)
        val widget = terminalView.createLocalShellWidget(project.basePath ?: "", TERMINAL_TITLE)
        widget.executeCommand(MIPHAM_COMMAND)
    }
}

/**
 * Focus: bring the Terminal tool window to front.
 */
class MiphamFocusAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ToolWindowManager.getInstance(project).getToolWindow("Terminal")?.activate(null)
    }
}

/**
 * OpenConfig: open Settings -> Tools -> Mipham Code.
 */
class MiphamOpenConfigAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ShowSettingsUtil.getInstance().showSettingsDialog(project, "Mipham Code")
    }
}

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
 * Settings UI panel: Tools -> Mipham Code.
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
        MiphamSettings.getInstance().loadState(
            MiphamSettings.State(
                bunPath = bunPathField.text,
                provider = providerField.text,
                model = modelField.text
            )
        )
    }

    override fun reset() {
        val settings = MiphamSettings.getInstance().state
        bunPathField.text = settings.bunPath
        providerField.text = settings.provider
        modelField.text = settings.model
    }
}

/**
 * Show a one-time notification when a project opens.
 */
class MiphamStartupListener : ProjectManagerListener {
    override fun projectOpened(project: Project) {
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup("Mipham Code")
            .createNotification(
                "Mipham Code is ready. Press Cmd+Esc to start.",
                NotificationType.INFORMATION
            )
        notification.notify(project)
    }
}
