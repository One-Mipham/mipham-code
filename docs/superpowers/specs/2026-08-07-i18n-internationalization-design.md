# i18n 国际化 — Mipham Code 多语言支持设计规格

> **版本**: 1.0.0
> **日期**: 2026-08-07
> **状态**: 设计通过，待实施
> **范围**: CLI (React/Ink) + Web (Next.js 14 SSG) + install.sh + VS Code 扩展

---

## 一、目标

为 Mipham Code 全栈（CLI 终端、Web 产品页、安装脚本、VS Code 扩展）添加多语言国际化支持。初始阶段支持简体中文（zh-CN）和英文（en-US），架构设计允许后续扩展更多语言。

---

## 二、范围

| 子系统 | 用户可见字符串 | 说明 |
|--------|--------------|------|
| CLI UI + Commands | ~3,200 | Ink 终端组件 + 74 条 slash 命令响应 |
| Web 产品页 | ~120 | Next.js SSG 5 页面 + 5 组件 |
| install.sh | ~25 | 一键安装脚本 |
| VS Code / Brew | ~80 | extension.js + package.json + README |
| **合计** | **~3,400** | |

---

## 三、架构

### 3.1 整体结构

```
packages/shared/src/i18n/
├── types.ts           # Locale 类型, TranslationMap, I18nBundle
├── t.ts               # t(key, params?) 零依赖翻译函数
├── detect.ts          # 语言检测优先级链
└── locales/
    ├── en-US.json     # 英文（fallback，始终加载）
    └── zh-CN.json     # 简体中文

apps/cli/src/
├── i18n-context.ts    # React Context: I18nProvider + useI18n() hook
└── index.tsx           # 启动时检测语言 → loadTranslationFiles() → 注入

apps/web/src/i18n/
├── context.tsx         # 'use client' Context（同 CLI 模式）
└── index.ts            # 翻译 bundle import（构建时内联）
```

### 3.2 核心 t() 函数

零依赖，~30 行。查找当前语言的嵌套 key，fallback 到英文，最后返回 key 本身。

```typescript
// packages/shared/src/i18n/t.ts
export function createT(current: TranslationMap, fallback: TranslationMap) {
  return function t(key: string, params?: Record<string, string>): string {
    const val = getNested(current, key) ?? getNested(fallback, key) ?? key
    if (typeof val !== 'string') return key
    return params
      ? val.replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? '')
      : val
  }
}

function getNested(obj: TranslationMap, key: string): unknown {
  return key.split('.').reduce((o: any, k) => o?.[k], obj)
}
```

### 3.3 翻译文件加载

- **CLI**: 启动时 `readFileSync` 同步读取两个 JSON 文件（~100KB 合计），Bun/Node 瞬间完成
- **Web**: 构建时将 JSON 直接 `import` 为 TS 常量（SSG 兼容），零运行时请求
- **install.sh**: shell 变量 + `case $LANG` 分支，无依赖

---

## 四、语言检测优先级

```
1. CLI --lang 参数          $ mipham --lang zh-CN
2. USER.md 设置             language: zh-CN
3. 环境变量                  $LANG / $LC_ALL → "zh_CN.UTF-8"
4. OS 语言                   macOS: defaults read, Windows: GetUserDefaultLocaleName
5. 兜底                      en-US
```

**Web 端**: `navigator.language` 检测 + cookie 覆盖（用户可通过 UI 切换）。

**install.sh**: `$LANG` 环境变量检测。

`detect.ts` 导出 `detectLocale(): Locale`，启动时调用一次，结果缓存在 Context 中。

---

## 五、翻译 Key 命名规范

按文件路径 + 语义分层，`.` 分隔，全小写：

```
# Slash 命令响应 (ui/commands.ts)
commands.clear.confirmed     = "✓ Conversation cleared. Context reset."
commands.status.title        = "── System Diagnostics ──"

# UI 组件 (ui/*.tsx)
ui.banner.title              = "Mipham Code"
ui.banner.subtitle           = "AI-Powered Programming Assistant"
ui.loading.doodling          = "Doodling"
ui.permission.auto           = "auto mode"

# 工具描述 (tools/**/*.ts)
tools.bash.name              = "Bash"
tools.bash.description       = "Execute shell commands..."

# 错误/系统消息
errors.tool_not_allowed      = "Tool \"{name}\" requires user approval"
system.mcp.connecting        = "[mcp] Connecting to \"{name}\"..."

# Web 页面
web.hero.title               = "Mipham Code"
web.install.method_curl      = "curl"
web.footer.copyright         = "© 2026 One Mipham Corporation"
```

原则：
- 按源文件分组，key 能直接追溯到定义位置
- `{param}` 模板变量用花括号
- 所有 key 英文命名（便于跨语言团队理解）

---

## 六、CLI 集成

### 6.1 React Context

```tsx
// apps/cli/src/i18n-context.ts
import React, { createContext, useContext } from 'react'
import type { Locale, TranslationMap } from '@mipham/shared/i18n/types'

interface I18nContextValue {
  locale: Locale
  t: (key: string, params?: Record<string, string>) => string
}

const I18nContext = createContext<I18nContextValue>(/* default */)

export function I18nProvider({ locale, t, children }: ...) { ... }
export function useI18n(): I18nContextValue { return useContext(I18nContext) }
```

### 6.2 启动注入

```tsx
// apps/cli/src/index.tsx
const locale = detectLocale(options.lang)
const translations = loadTranslations(locale) // 同步 readFileSync
const t = createT(translations, fallbackEn)

render(
  <I18nProvider locale={locale} t={t}>
    <App ... />
  </I18nProvider>
)
```

### 6.3 组件使用

```tsx
const { t } = useI18n()
return <Text>{t('commands.clear.confirmed')}</Text>
```

### 6.4 热切换语言

提供 `/lang <locale>` slash command，更新 Context state 触发全 UI re-render。

---

## 七、Web 集成

### 7.1 翻译加载

构建时将 JSON 内联为 TS 常量（SSG 兼容）：

```typescript
// apps/web/src/i18n/index.ts
import zhCN from '@mipham/shared/i18n/locales/zh-CN.json'
import enUS from '@mipham/shared/i18n/locales/en-US.json'

export const bundles: Record<string, TranslationMap> = { 'zh-CN': zhCN, 'en-US': enUS }
```

### 7.2 语言检测

`layout.tsx` 改为 `'use client'`，检测 `navigator.language` → 映射到最匹配的 locale → 设置 `<html lang>`。

### 7.3 使用方式

```tsx
'use client'
import { useI18n } from '@/i18n/context'

export function Hero() {
  const { t } = useI18n()
  return <h1>{t('web.hero.title')}</h1>
}
```

### 7.4 SSG 兼容

- `output: 'export'` 模式下不能有服务端 i18n 路由
- 翻译数据随 JS bundle 一起静态导出
- 语言切换通过客户端状态，不需要服务端路由

---

## 八、install.sh 国际化

使用 shell `case` 分支检测 `$LANG`：

```bash
detect_lang() {
  case "$LANG" in
    zh_CN*|zh_CN.*) echo "zh-CN" ;;
    *)              echo "en-US" ;;
  esac
}

MSG_INSTALL_SUCCESS_EN="Mipham Code installed successfully!"
MSG_INSTALL_SUCCESS_ZH="Mipham Code 安装成功！"

t() {
  local key="$1"
  local lang=$(detect_lang)
  eval "echo \${${key}_${lang/-/_}}"
}

echo "$(t MSG_INSTALL_SUCCESS)"
```

---

## 九、VS Code / Brew 国际化

| 文件 | 策略 |
|------|------|
| `package.json` `displayName`/`description` | 保持英文（VS Code Marketplace 约定） |
| `extension.js` 状态栏/通知 | `t()` 函数 + 翻译 JSON import |
| `README.md` | 保持英文（GitHub 展示） |
| `mipham.rb` | 保持英文（Homebrew 约定） |

市场约定不翻译的保持英文，运行时可翻译的通知消息用 `t()`。

---

## 十、测试策略

### 10.1 t() 函数单元测试

```typescript
it('returns translation for known key', () => {
  const t = createT({ hello: '你好' }, { hello: 'Hello' })
  expect(t('hello')).toBe('你好')
})

it('falls back to en-US for missing key', () => {
  const t = createT({}, { hello: 'Hello' })
  expect(t('hello')).toBe('Hello')
})

it('returns key for completely missing translation', () => {
  const t = createT({}, {})
  expect(t('unknown.key')).toBe('unknown.key')
})

it('interpolates params', () => {
  const t = createT({ greeting: '你好 {name}' }, { greeting: 'Hello {name}' })
  expect(t('greeting', { name: 'World' })).toBe('你好 World')
})
```

### 10.2 语言检测测试

```typescript
it('detects zh-CN from --lang flag', () => {
  expect(detectLocale({ lang: 'zh-CN' })).toBe('zh-CN')
})

it('detects from LANG env var', () => {
  process.env.LANG = 'zh_CN.UTF-8'
  expect(detectLocale({})).toBe('zh-CN')
})

it('falls back to en-US', () => {
  expect(detectLocale({})).toBe('en-US')
})
```

### 10.3 集成测试

- 每个 slash command 验证中英文输出都非空、不含未解析 key
- 验证 Web 页面中英文渲染无 broken 布局

### 10.4 零回归约束

- 现有 853 测试必须全部通过
- 默认行为（`--lang` 未指定）= en-US，UI 输出不变

---

## 十一、实施范围与阶段

| 阶段 | 内容 | 预估字符串 |
|------|------|-----------|
| Phase 1: 基础设施 | types.ts + t.ts + detect.ts + locales JSON 骨架 + eslint 插件禁用 key-check | — |
| Phase 2: CLI Core | i18n-context.tsx + index.tsx 注入 + `/lang` 命令 | ~200 核心字符串 |
| Phase 3: CLI Slash Commands | ui/commands.ts (~74 条响应) + commands/*.ts (~6 文件) | ~500 |
| Phase 4: CLI UI Components | ui/*.tsx (app, chat, input, picker, footer, agent-footer) | ~300 |
| Phase 5: CLI Tools + Engine | tools/** 描述 + core/engine.ts 错误消息 | ~900 |
| Phase 6: Web 产品页 | 5 页面 + 5 组件全部 | ~120 |
| Phase 7: install.sh + VS Code | 脚本 + extension.js | ~100 |
| Phase 8: 补全 + 验证 | 剩余字符串 + 中英文一致性检查 + manual QA | ~1,380 |

---

## 十二、技术决策总结

| 决策 | 选项 | 理由 |
|------|------|------|
| 框架 | 自研 JSON + t() | 零依赖，CLI 二进制不受影响，~30 行代码 |
| 类型安全 | 运行时 fallback（非编译期） | 简单，key 拼写错误 fallback 到英文 |
| 初始语言 | zh-CN + en-US | 覆盖 95% 用户 |
| CLI 注入 | React Context | 支持热切换 `/lang`，易 mock 测试 |
| 翻译加载（CLI） | 同步 readFileSync | 启动时一次读 ~100KB，零延迟 |
| 翻译加载（Web） | 构建时 import 内联 | SSG compatible，零运行时请求 |
| Key 命名 | 点分隔全小写 | 直观，按文件路径组织 |
| 回退策略 | en-US → key 本身 | 永远不会空白输出 |

---

## 十三、修订历史

| 版本 | 日期 | 变更 | 维护人 |
|------|------|------|--------|
| 1.0.0 | 2026-08-07 | 初始设计 | 技术委员会 |
