# Mipham Code — JetBrains Plugin Changelog

## 0.44.2 (2026-08-17)

- Remove `<icon>` from plugin.xml (unsupported in IntelliJ 2024.3; caused "invalid plugin descriptor")
- Ship plugin icon as standalone asset for the Marketplace listing

## 0.44.0 (2026-08-17)

- Version sync with Mipham Code CLI 0.44.0
- Wire plugin settings (bun path / provider / model) into the start command

## 0.21.0 (2026-08-07)

- Initial release
- Start Mipham Code in IDE Terminal (`Cmd+Esc`)
- Focus existing Mipham terminal (`Cmd+Shift+M`)
- Open plugin settings (`Tools → Mipham Code: Open Settings`)
- Configurable: bun path, default provider, default model
- Compatible with IntelliJ IDEA, WebStorm, PyCharm, GoLand, Rider, CLion, DataGrip
