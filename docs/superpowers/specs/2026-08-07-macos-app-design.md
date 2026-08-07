# Mipham Code — macOS .app + Homebrew Cask 设计 Spec

> **版本**: 1.0.0
> **日期**: 2026-08-07
> **阶段**: 生态扩展 — macOS 原生应用 + DMG 分发
> **维护人**: One Mipham Corporation 技术委员会

---

## 一、目标

将 Mipham Code CLI 打包为 macOS 原生 `.app` 应用，用户双击即可在 Terminal 中启动。通过 DMG 分发给非 CLI 用户，同时提供 Homebrew Cask 安装。

---

## 二、设计方案

**方式 A + C 组合**：App Bundle（双击启动 Terminal）+ Homebrew Cask（`brew install --cask mipham`）

### 2.1 文件结构

```
infrastructure/macos/
├── Mipham Code.app/
│   └── Contents/
│       ├── Info.plist                  # Bundle 元数据
│       ├── MacOS/
│       │   └── MiphamCode              # 可执行启动脚本
│       └── Resources/
│           └── icon.icns               # → 复制自 apps/cli/assets/icon.icns
├── create-app.sh                       # 构建 .app 脚本
├── create-dmg.sh                       # DMG 打包脚本
└── entitlements.plist                  # Apple 公证用

infrastructure/brew/
└── mipham-cask.rb                      # Homebrew Cask formula（新建）
```

### 2.2 Info.plist 规约

```xml
<key>CFBundleExecutable</key>
<string>MiphamCode</string>
<key>CFBundleIconFile</key>
<string>icon</string>
<key>CFBundleIdentifier</key>
<string>ai.mipham.code</string>
<key>CFBundleName</key>
<string>Mipham Code</string>
<key>CFBundleVersion</key>
<string>0.21.0</string>
<key>LSBackgroundOnly</key>
<false/>
<key>LSUIElement</key>
<false/>
```

### 2.3 启动脚本逻辑

```bash
#!/bin/bash
# 1. 检测 mipham 是否已安装
if command -v mipham &>/dev/null; then
    open -a Terminal --args -e "mipham"
else
    # 2. 未安装 → 弹窗提示
    osascript -e 'display dialog "Mipham Code is not installed.\n\nRun this in Terminal:\ncurl -fsSL https://mipham.ai/install.sh | bash" \
        with title "Mipham Code" buttons {"Copy Command", "OK"} default button "OK"'
fi
```

### 2.4 DMG 打包

```bash
# create-dmg.sh
hdiutil create -volname "Mipham Code" \
    -srcfolder "Mipham Code.app" \
    -ov -format UDZO \
    "mipham-code-${VERSION}.dmg"
```

### 2.5 Homebrew Cask

```ruby
# infrastructure/brew/mipham-cask.rb
cask "mipham" do
  version "0.21.0"
  sha256 "PLACEHOLDER"
  url "https://mipham.ai/dl/mipham-code-#{version}.dmg"
  name "Mipham Code"
  desc "Multi-model open-core intelligent coding terminal"
  homepage "https://mipham.ai/code"

  app "Mipham Code.app"

  zap trash: [
    "~/.mipham",
  ]
end
```

### 2.6 Apple 公证

DMG 上传前需通过 Apple 公证（`notarytool submit`），确保 Gatekeeper 不拦截。需要 Apple Developer 账号（免费账号即可，企业签名不必须）。

---

## 三、不做

- ❌ 不做 Swift 原生终端包装（保持 Terminal.app 方式，与 VS Code/JetBrains 一致）
- ❌ 不做 .app 自动更新（brew cask upgrade 覆盖此需求）
- ❌ 不做 Windows .exe / Linux .AppImage（后续专项）
- ❌ 不做 Mac App Store 分发（审核周期长，brew cask 更快）

---

## 四、分发流程

```
1. bun build --compile → mipham 二进制
2. create-app.sh → Mipham Code.app
3. create-dmg.sh → mipham-code-0.21.0.dmg
4. codesign + notarytool → 签名 + 公证
5. 上传到 mipham.ai/dl/
6. Homebrew Cask PR → brew install --cask mipham
```

---

### 修订历史

| 版本  | 日期       | 变更内容 | 维护人     |
| ----- | ---------- | -------- | ---------- |
| 1.0.0 | 2026-08-07 | 初版     | 技术委员会 |
