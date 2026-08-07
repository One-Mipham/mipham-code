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
