plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "ai.mipham"
version = project.property("pluginVersion").toString()

repositories {
    mavenCentral()
}

intellij {
    version.set(project.property("platformVersion").toString())
    plugins.set(listOf("org.jetbrains.plugins.terminal"))
}

kotlin {
    jvmToolchain(17)
}

tasks {
    patchPluginXml {
        sinceBuild.set("243")
        untilBuild.set("")
    }

    publishPlugin {
        // Token 从环境变量读，绝不硬编码（生成：https://plugins.jetbrains.com/author/me/tokens）
        token.set(providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN"))
    }
}
