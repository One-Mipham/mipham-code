# Mipham Code — JetBrains Plugin

Multi-model AI coding terminal for all JetBrains IDEs.

## Install

1. Download `mipham-code-jetbrains-0.44.0.zip` from [releases](https://github.com/One-Mipham/mipham-code/releases)
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

## Known Limitations

- **`Esc` key in the embedded terminal**: Mipham Code uses a React/Ink terminal UI that needs full terminal emulation. The JetBrains embedded terminal may not deliver a standalone `Esc` press (it is the prefix for ANSI escape sequences). Use **`Ctrl+C`** to exit/interrupt, or run `mipham` in a native terminal (iTerm2 / Terminal.app) for full key support.

## Build from Source

```bash
cd infrastructure/jetbrains
./gradlew buildPlugin
# Output: build/distributions/mipham-code-jetbrains-0.44.0.zip
```
