# Ollama 完整集成 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ollama 成为一等公民 provider——ConfigWizard 可交互选择模型，对话中可热切换到 Ollama/云端模型，缺失 API Key 时按需补录。

**Architecture:** Ollama 复用现有 `OpenAICompatProvider`（API 兼容），动态模型发现通过 `ollama list` 命令。ConfigWizard Ollama 步骤从 TextInput 改为列表选择。运行时 API Key 补录在 `/switch` 和 ModelPicker 两个入口实现。

**Tech Stack:** TypeScript 5.5+, React/Ink 5, Bun runtime, Ollama CLI

## Global Constraints

- 所有 provider 保持字母序排列（DEFAULT_PROVIDERS）
- 提交信息遵循 Conventional Commits
- 代码风格：ESLint (flat config) + Prettier，CI 强制执行
- 现有 1020 个测试必须保持绿色
- Ollama 模型 `contextWindow` 默认 128_000，`vision` 默认 false，`maxOutput` 默认 32_000
- `apiKey: 'ollama-local'` 视为"无需 API Key"，不触发补录流程

---

### Task 1: 在 DEFAULT_PROVIDERS 中新增 Ollama + 预置模型常量

**Files:**

- Modify: `apps/cli/src/shared/constants.ts`

**Interfaces:**

- Produces: `OLLAMA_PRESET_MODELS` 常量（`Array<{ id: string; source: string }>`）
- Produces: Ollama 条目加入 `DEFAULT_PROVIDERS` 数组

- [ ] **Step 1: 在 DEFAULT_PROVIDERS 数组中新增 Ollama 条目**

在 `apps/cli/src/shared/constants.ts` 中，`deepseek` 之前插入（保持字母序，`ollama` 排在 `o`）：

```typescript
// 在 deepseek 之前插入
{
  id: 'ollama',
  name: 'Ollama (本地)',
  protocol: 'openai-compatible' as const,
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'ollama-local',
  models: [],  // 动态发现，初值为空
},
```

- [ ] **Step 2: 新增 OLLAMA_PRESET_MODELS 常量**

在同一文件末尾（`TOOL_CATEGORIES` 之后）添加：

```typescript
/** 预置 Ollama 模型 — 与 ollama list 结果合并去重后展示 */
export const OLLAMA_PRESET_MODELS = [
  { id: 'om-V5-Flash', source: 'MiphamAI' },
  { id: 'om-V5-Pro', source: 'MiphamAI' },
  { id: 'om-V5-Visual', source: 'MiphamAI' },
  { id: 'om-V5-Apex', source: 'MiphamAI' },
  { id: 'deepseek-r1:70b', source: '热门' },
  { id: 'deepseek-v3', source: '热门' },
  { id: 'qwen2.5:72b', source: '热门' },
  { id: 'qwen3', source: '热门' },
] as const
```

- [ ] **Step 3: Typecheck 验证**

```bash
cd apps/cli && pnpm typecheck
```

Expected: PASS（Ollama 条目符合 ProviderConfig 类型）

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/shared/constants.ts
git commit -m "feat(providers): add Ollama to DEFAULT_PROVIDERS with preset models"
```

---

### Task 2: Ollama 动态模型发现 — listModels()

**Files:**

- Modify: `apps/cli/src/providers/openai-compat.ts`

**Interfaces:**

- Consumes: `OLLAMA_PRESET_MODELS` from `../shared/constants`
- Modifies: `listModels()` 方法 — Ollama 特判动态执行 `ollama list`

- [ ] **Step 1: 修改 listModels() 方法**

在 `apps/cli/src/providers/openai-compat.ts` 顶部添加 import：

```typescript
import { execSync } from 'node:child_process'
import { OLLAMA_PRESET_MODELS } from '../shared/constants'
```

将 `listModels()` 方法（约 line 169-171）替换为：

```typescript
async listModels(): Promise<ModelInfo[]> {
  if (this.config.id === 'ollama') {
    return this.listOllamaModels()
  }
  return this.config.models.filter((m) => m.status === 'active')
}

private listOllamaModels(): ModelInfo[] {
  const seen = new Set<string>()
  const result: ModelInfo[] = []

  // 1. ollama list 本地已下载模型
  try {
    const out = execSync('ollama list', { timeout: 5000, encoding: 'utf-8' })
    const lines = out.split('\n').slice(1).filter(Boolean)
    for (const line of lines) {
      const name = line.split(/\s+/)[0]!
      if (!seen.has(name)) {
        seen.add(name)
        result.push({
          id: name,
          name,
          providerId: 'ollama',
          contextWindow: 128_000,
          maxOutput: 32_000,
          vision: false,
          status: 'active',
        })
      }
    }
  } catch {
    // ollama list 失败（未安装/未运行）→ 继续返回预置模型
  }

  // 2. 预置模型（去重）
  for (const preset of OLLAMA_PRESET_MODELS) {
    if (!seen.has(preset.id)) {
      seen.add(preset.id)
      result.push({
        id: preset.id,
        name: `${preset.id} [${preset.source}]`,
        providerId: 'ollama',
        contextWindow: 128_000,
        maxOutput: 32_000,
        vision: false,
        status: 'active',
      })
    }
  }

  return result
}
```

- [ ] **Step 2: Typecheck + 现有测试回归**

```bash
cd apps/cli && pnpm typecheck && pnpm test
```

Expected: typecheck PASS, 所有已有测试 PASS（listModels 不属于核心测试路径）

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/providers/openai-compat.ts
git commit -m "feat(providers): add dynamic Ollama model discovery via ollama list"
```

---

### Task 3: ConfigWizard Ollama 步骤 — TextInput → 列表选择

**Files:**

- Modify: `apps/cli/src/ui/config-wizard.tsx`

**Interfaces:**

- Consumes: `OLLAMA_PRESET_MODELS` from `../shared/constants`
- Modifies: Ollama 步骤 UI — 从 TextInput 改为箭头键列表选择

- [ ] **Step 1: 添加 import**

在 `config-wizard.tsx` 顶部 import 中添加：

```typescript
import { DEFAULT_PROVIDERS, OLLAMA_PRESET_MODELS } from '../shared/constants'
```

- [ ] **Step 2: 新增 getOllamaModelList 辅助函数**

在 `checkOllama()` 函数之后添加（约 line 89）：

```typescript
interface OllamaModelItem {
  id: string
  source: 'local' | 'MiphamAI' | '热门'
}

function getOllamaModelList(installedModels: string[]): OllamaModelItem[] {
  const seen = new Set<string>()
  const result: OllamaModelItem[] = []

  // ollama list 返回的本地模型
  for (const name of installedModels) {
    if (!seen.has(name)) {
      seen.add(name)
      result.push({ id: name, source: 'local' })
    }
  }

  // 预置模型（去重）
  for (const preset of OLLAMA_PRESET_MODELS) {
    if (!seen.has(preset.id)) {
      seen.add(preset.id)
      result.push({ id: preset.id, source: preset.source as 'MiphamAI' | '热门' })
    }
  }

  return result
}

function sourceLabel(source: 'local' | 'MiphamAI' | '热门'): string {
  if (source === 'MiphamAI') return '[MiphamAI]'
  if (source === '热门') return '[热门]'
  return ''
}
```

- [ ] **Step 3: 新增 ollamaCursor state**

在 state 声明区域（约 line 108，`ollamaStatus` state 之后）添加：

```typescript
const [ollamaCursor, setOllamaCursor] = useState(0)
const ollamaModelList = ollamaStatus ? getOllamaModelList(ollamaStatus.models) : []
```

- [ ] **Step 4: 修改 goStep 重置 ollamaCursor**

在 `goStep` 函数中添加 `ollamaCursor` 重置（约 line 116-120）：

```typescript
const goStep = (s: Step) => {
  setCursor(0)
  setOllamaCursor(0)
  setError(null)
  setStep(s)
}
```

- [ ] **Step 5: 修改 finishLocal 使用列表选中的模型**

将 `finishLocal` 函数（约 line 137-145）中的第一行替换：

```typescript
const finishLocal = () => {
  const selectedModel = ollamaModelList[ollamaCursor]
  const model = selectedModel?.id || ollamaModel.trim() || 'llama3.2'
  // ... 其余不变
```

- [ ] **Step 6: 添加 Ollama 步骤键盘导航**

在 `useInput` 的 Ollama 步骤处理中（约 line 181 附近，Esc 处理之后），添加箭头键导航：

```typescript
// 在 esc 处理 ollama 之后，添加：
if (step === 'ollama') {
  if (key.upArrow) {
    setOllamaCursor((c) => (c > 0 ? c - 1 : ollamaModelList.length - 1))
    return
  }
  if (key.downArrow) {
    setOllamaCursor((c) => (c < ollamaModelList.length - 1 ? c + 1 : 0))
    return
  }
  if (key.return) {
    goStep('confirm')
    return
  }
  return
}
```

注意：需要将这部分放在 `step === 'ollama'` Esc 处理之后、但在 `return` 之前。当前代码结构中，`step === 'ollama'` 的 Esc 在约 line 181-183，需要在该 `if` 块之后（但在外层 return 之前）添加导航逻辑。

- [ ] **Step 7: 替换 Ollama 步骤渲染**

将 Ollama 步骤的渲染部分（约 line 397-432）替换为列表选择 UI：

```typescript
{/* ── Ollama ── */}
{step === 'ollama' && (
  <Box flexDirection="column">
    <Box marginBottom={1}>
      <Text bold>Ollama 本地模型配置：</Text>
    </Box>
    {ollamaStatus ? (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          状态：{ollamaStatus.installed ? '✅ 已安装' : '❌ 未安装'}
          {ollamaStatus.running ? ' · 运行中' : ollamaStatus.installed ? ' · 未运行（请执行 ollama serve）' : ''}
        </Text>
      </Box>
    ) : (
      <Text dimColor>正在检测 Ollama...</Text>
    )}
    {ollamaModelList.length > 0 && (
      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={1}>
          <Text dimColor>已下载模型（↑↓ 选择 · Enter 确认）：</Text>
        </Box>
        {ollamaModelList.map((m, i) => (
          <Box key={m.id}>
            <Text color={i === ollamaCursor ? 'cyan' : undefined}>
              {i === ollamaCursor ? '▶' : '  '} {m.id}
            </Text>
            {m.source !== 'local' && (
              <Text dimColor> [{m.source === 'MiphamAI' ? 'MiphamAI' : '热门'}]</Text>
            )}
          </Box>
        ))}
      </Box>
    )}
    {ollamaStatus && ollamaModelList.length === 0 && (
      <Box marginBottom={1}>
        <Text dimColor>
          未检测到已下载模型。请先运行 ollama pull &lt;model&gt; 下载模型。
        </Text>
        <Text dimColor>
          以下为预置模型列表，选择后可在对话中通过 /models 切换。
        </Text>
      </Box>
    )}
    <Box marginTop={1}>
      <Text dimColor>↑↓ 选择 · Enter 确认 · Esc 返回</Text>
    </Box>
  </Box>
)}
```

- [ ] **Step 8: Typecheck + 运行 ConfigWizard 测试**

```bash
cd apps/cli && pnpm typecheck && pnpm test -- --testPathPattern="config-wizard"
```

Expected: typecheck PASS, 34 个已有测试可能需要更新（Ollama 步骤渲染逻辑变更）

- [ ] **Step 9: 更新测试文件**

读 `apps/cli/test/ui/config-wizard.test.ts`，更新受影响的测试用例。主要变更：

- Ollama 步骤不再使用 TextInput → 测试中移除相关 TextInput 断言
- 新增列表导航测试（↑↓ 移动 ollamaCursor、Enter 选中）
- `finishLocal` 使用列表选中模型

- [ ] **Step 10: Commit**

```bash
git add apps/cli/src/ui/config-wizard.tsx apps/cli/test/ui/config-wizard.test.ts
git commit -m "feat(ui): ConfigWizard Ollama step — interactive model list selection"
```

---

### Task 4: writeConfigFile Ollama 配置补全

**Files:**

- Modify: `apps/cli/src/ui/config-wizard.tsx`

**Interfaces:**

- Consumes: `OLLAMA_PRESET_MODELS` (已在 Task 3 import)
- Modifies: `writeConfigFile()` — Ollama 特判补全 baseUrl + models

- [ ] **Step 1: 修改 writeConfigFile 对 Ollama 特殊处理**

在 `writeConfigFile()` 函数中（约 line 43-69），修改 models 行的生成逻辑。找到函数内 `const models = getActiveModels(providerId)` 这一行（约 line 48），将其替换为：

```typescript
const models = providerId === 'ollama' ? getOllamaModelListForConfig() : getActiveModels(providerId)

function getOllamaModelListForConfig(): ModelInfo[] {
  // 与 listOllamaModels 逻辑一致，但用于配置写入
  const seen = new Set<string>()
  const result: ModelInfo[] = []

  // ollama list
  try {
    const out = execSync('ollama list', { timeout: 5000, encoding: 'utf-8' })
    const lines = out.split('\n').slice(1).filter(Boolean)
    for (const line of lines) {
      const name = line.split(/\s+/)[0]!
      if (!seen.has(name)) {
        seen.add(name)
        result.push({
          id: name,
          name,
          providerId: 'ollama',
          contextWindow: 128_000,
          maxOutput: 32_000,
          vision: false,
          status: 'active',
        })
      }
    }
  } catch {
    /* ollama not available */
  }

  for (const p of OLLAMA_PRESET_MODELS) {
    if (!seen.has(p.id)) {
      seen.add(p.id)
      result.push({
        id: p.id,
        name: p.id,
        providerId: 'ollama',
        contextWindow: 128_000,
        maxOutput: 32_000,
        vision: false,
        status: 'active',
      })
    }
  }
  return result
}
```

注意：此函数需要访问 `OLLAMA_PRESET_MODELS`（已在 Task 3 导入）。`execSync` 已在 config-wizard.tsx 顶部导入（line 19）。

- [ ] **Step 2: Typecheck + 测试**

```bash
cd apps/cli && pnpm typecheck && pnpm test -- --testPathPattern="config-wizard"
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/ui/config-wizard.tsx
git commit -m "fix(ui): writeConfigFile generates complete Ollama provider config"
```

---

### Task 5: 新增 /ollama-refresh 命令

**Files:**

- Modify: `apps/cli/src/ui/commands.ts`

**Interfaces:**

- Consumes: `CommandContext`, `CommandHandler`, `CommandResult`
- Produces: `ollamaRefreshCmd` handler，注册在 `Model & Provider` 分类

- [ ] **Step 1: 添加 /ollama-refresh 命令处理函数**

在 `commands.ts` 中，`modelsCmd` 之后（约 line 352）添加：

```typescript
const ollamaRefreshCmd: CommandHandler = (ctx) => {
  const t = resolveT(ctx)
  const ollamaProvider = ctx.config.providers.find((p) => p.id === 'ollama')
  if (!ollamaProvider) {
    return { content: t('commands.ollama_refresh.not_configured') }
  }

  const before = ollamaProvider.models.length
  try {
    // 刷新：重新加载配置后模型列表会更新
    // 直接调用 listModels 等效逻辑
    const { execSync } = require('node:child_process')
    const { OLLAMA_PRESET_MODELS } = require('../shared/constants')
    const seen = new Set<string>()
    const refreshed: Array<{ id: string }> = []

    const out = execSync('ollama list', { timeout: 5000, encoding: 'utf-8' })
    const lines = out.split('\n').slice(1).filter(Boolean)
    for (const line of lines) {
      const name = line.split(/\s+/)[0]!
      if (!seen.has(name)) {
        seen.add(name)
        refreshed.push({ id: name })
      }
    }

    for (const p of OLLAMA_PRESET_MODELS) {
      if (!seen.has(p.id)) {
        seen.add(p.id)
        refreshed.push({ id: p.id })
      }
    }

    // 更新 config 中的模型列表
    ollamaProvider.models = refreshed.map((m) => ({
      id: m.id,
      name: m.id,
      providerId: 'ollama',
      contextWindow: 128_000,
      maxOutput: 32_000,
      vision: false,
      status: 'active' as const,
    }))

    const after = refreshed.length
    const added = after - before
    return {
      content: t('commands.ollama_refresh.done', {
        total: String(after),
        added: added > 0 ? `+${added}` : String(added),
      }),
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: t('commands.ollama_refresh.error', { error: msg }) }
  }
}
```

- [ ] **Step 2: 注册命令**

在命令注册区（约 line 3315，`registry.set('/models', modelsCmd)` 附近）添加：

```typescript
registry.set('/ollama-refresh', ollamaRefreshCmd)
```

在分类映射区（约 line 3171）添加：

```typescript
'/ollama-refresh': 'Model & Provider',
```

- [ ] **Step 3: 添加 i18n 字符串**

`/ollama-refresh` 需要以下 i18n key（中/英文）：

```json
// zh-CN
"commands.ollama_refresh.not_configured": "Ollama provider 未配置",
"commands.ollama_refresh.done": "Ollama 模型列表已刷新：共 {total} 个模型（{added}）",
"commands.ollama_refresh.error": "刷新失败：{error}",

// en-US
"commands.ollama_refresh.not_configured": "Ollama provider not configured",
"commands.ollama_refresh.done": "Ollama models refreshed: {total} total ({added})",
"commands.ollama_refresh.error": "Refresh failed: {error}"
```

找到 `apps/cli/src/i18n-core/locales/zh-CN.json` 和 `en-US.json`，在 `commands` 节点下添加。

- [ ] **Step 4: Typecheck + 测试**

```bash
cd apps/cli && pnpm typecheck && pnpm test
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/ui/commands.ts apps/cli/src/i18n-core/locales/zh-CN.json apps/cli/src/i18n-core/locales/en-US.json
git commit -m "feat(commands): add /ollama-refresh command for dynamic model list update"
```

---

### Task 6: /switch + ModelPicker — API Key 缺失时按需补录

**Files:**

- Modify: `apps/cli/src/ui/commands.ts` — `switchCmd`
- Modify: `apps/cli/src/ui/picker.tsx` — `ModelPicker`

**Interfaces:**

- Consumes: `MiphamConfig`, `ProviderConfig` from shared types
- Produces: `isApiKeyMissing()` helper
- Modifies: `switchCmd` 返回 `needsApiKey` 标记
- Modifies: `ModelPicker` 的 `onSelect` 回调增加 apiKey 检测

- [ ] **Step 1: 新增 isApiKeyMissing 辅助函数**

在 `commands.ts` 中 `switchCmd` 之前添加：

```typescript
/** 检测 API Key 是否未配置（空值或仍为占位符） */
function isApiKeyMissing(apiKey: string): boolean {
  if (!apiKey || apiKey.trim() === '') return true
  if (apiKey === 'ollama-local') return false // Ollama 免 Key
  if (/^\$\{[A-Z_]+\}$/.test(apiKey.trim())) return true // ${VAR} 占位符
  return false
}
```

- [ ] **Step 2: 修改 switchCmd 增加 apiKey 检测**

将现有的 `switchCmd`（约 line 372-384）替换为：

```typescript
const switchCmd: CommandHandler = (ctx, args) => {
  const t = resolveT(ctx)
  const [newProvider, newModel] = args
  if (!newProvider || !newModel) {
    return { content: t('commands.switch.usage') }
  }

  const provider = ctx.config.providers.find((p) => p.id === newProvider)
  if (!provider) {
    return { content: t('commands.switch.unknown_provider', { provider: newProvider }) }
  }

  // 检测 API Key
  if (isApiKeyMissing(provider.apiKey)) {
    return {
      content: t('commands.switch.needs_api_key', { provider: provider.name }),
      needsApiKey: { providerId: newProvider, modelId: newModel, providerName: provider.name },
    }
  }

  ctx.engine.switchProvider(newProvider, newModel)
  return {
    content: t('commands.switch.confirmed', { provider: newProvider, model: newModel }),
    nextProvider: newProvider,
    nextModel: newModel,
  }
}
```

- [ ] **Step 3: 更新 CommandResult 类型**

在 `commands.ts` 的 `CommandResult` 接口（约 line 66-69）中添加：

```typescript
export interface CommandResult {
  content: string
  exit?: boolean
  nextProvider?: string
  nextModel?: string
  /** API Key 补录请求：切换前需用户输入 Key */
  needsApiKey?: {
    providerId: string
    modelId: string
    providerName: string
  }
  // ... 其余不变
}
```

- [ ] **Step 4: 修改 ModelPicker — onSelect 增加 apiKey 检测**

`ModelPicker` 接口增加 `providers` 访问能力。在 `confirmSelection` 回调中（约 line 59-65），修改为传递给父组件的回调包含 provider 信息，让父组件做 apiKey 检测。更简单的方式是直接在 ModelPicker 内部检测：

修改 `PickerProps` 接口（约 line 6-12），`onSelect` 改为可返回 apiKey 需求：

```typescript
interface PickerProps {
  config: MiphamConfig
  currentProvider: string
  currentModel: string
  onSelect: (providerId: string, modelId: string) => void
  onNeedsApiKey?: (providerId: string, modelId: string, providerName: string) => void
  onClose: () => void
}
```

在 `confirmSelection` 中（约 line 59-65）：

```typescript
const confirmSelection = useCallback(() => {
  if (!selectedProvider) return
  const model = models[modelIdx]
  if (model) {
    // 检测 API Key
    const apiKey = selectedProvider.apiKey
    if (!apiKey || apiKey.trim() === '' || /^\$\{[A-Z_]+\}$/.test(apiKey.trim())) {
      if (selectedProvider.id !== 'ollama' && onNeedsApiKey) {
        onNeedsApiKey(selectedProvider.id, model.id, selectedProvider.name)
        return
      }
    }
    onSelect(selectedProvider.id, model.id)
  }
}, [selectedProvider, models, modelIdx, onSelect, onNeedsApiKey])
```

- [ ] **Step 5: 在 App 层处理 needsApiKey 回调**

需要在 App 组件（或调用 ModelPicker 的父组件）中处理 `onNeedsApiKey` 事件，弹出 API Key 输入界面。

查看 `apps/cli/src/ui/app.tsx` 中 ModelPicker 的调用位置，添加 `onNeedsApiKey` 处理——打开一个 API Key 输入弹窗（`TextInput`），用户输入后：

1. 写入 config.yml（更新该 provider 的 apiKey 字段）
2. 重新加载配置
3. 执行切换

此步涉及 `app.tsx` 的改动，需要在 `apps/cli/src/ui/app.tsx` 中：

- 添加 `apiKeyPrompt` state（`{ providerId, modelId, providerName } | null`）
- 当 `apiKeyPrompt` 不为 null 时渲染一个 TextInput 弹窗
- 用户提交后写入 config.yml 并执行切换

- [ ] **Step 6: 添加 i18n 字符串**

```json
// zh-CN
"commands.switch.needs_api_key": "{provider} 需要 API Key。请使用 /switch <provider> <model> <apiKey> 或通过 Ctrl+P 选择模型时输入。",
"commands.switch.unknown_provider": "未知 provider: {provider}",
"ui.picker.needs_api_key": "{provider} 需要 API Key",
"ui.picker.api_key_placeholder": "粘贴 API Key 后按 Enter...",

// en-US
"commands.switch.needs_api_key": "{provider} requires an API Key. Use /switch <provider> <model> <apiKey> or input via Ctrl+P.",
"commands.switch.unknown_provider": "Unknown provider: {provider}",
"ui.picker.needs_api_key": "{provider} requires an API Key",
"ui.picker.api_key_placeholder": "Paste API Key and press Enter..."
```

- [ ] **Step 7: Typecheck + 全量测试**

```bash
cd apps/cli && pnpm typecheck && pnpm test
```

Expected: typecheck PASS, 所有测试 PASS

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/ui/commands.ts apps/cli/src/ui/picker.tsx apps/cli/src/ui/app.tsx apps/cli/src/i18n-core/locales/zh-CN.json apps/cli/src/i18n-core/locales/en-US.json
git commit -m "feat(ui): API Key on-demand input when switching to unconfigured cloud provider"
```

---

### Task 7: 端到端验证 & 最终回归

**Files:**

- 无新文件，验证所有改动

- [ ] **Step 1: 运行全量测试**

```bash
cd apps/cli && pnpm test
```

Expected: 所有测试 PASS（1020+ 测试，0 失败）

- [ ] **Step 2: 运行全量 typecheck**

```bash
cd apps/cli && pnpm typecheck
```

Expected: PASS

- [ ] **Step 3: 运行 lint + format**

```bash
cd apps/cli && pnpm lint && pnpm format
```

Expected: PASS（无 lint 错误，格式化无变更）

- [ ] **Step 4: 手动验证关键流程**

按以下路径手动测试：

1. **首次配置 Ollama 路径**:
   - 删除 `~/.mipham/config.yml`
   - 启动 `mipham`
   - ConfigWizard: Welcome → Mode: 本地模型 → Ollama 步骤
   - 验证：显示 ollama list 模型 + 8 个预置模型，箭头键可导航，Enter 选中
   - Confirm: 显示选中的模型名
   - 保存 → 进入对话

2. **对话中 /models 列出 Ollama 模型**:
   - 输入 `/models`，验证 Ollama 模型出现在列表中

3. **Ctrl+P 切换到 Ollama 模型**:
   - Ctrl+P 打开 ModelPicker，选择 Ollama → 选择模型 → 回车
   - 验证：立即切换，不弹出 API Key 输入

4. **切换到云端模型 — API Key 缺失**:
   - `/switch kimi kimi-k3`（假设未配置 Kimi Key）
   - 验证：提示 "Kimi 需要 API Key"

5. **Ctrl+P 切换到云端模型 — API Key 补录**:
   - Ctrl+P → 选择 Kimi → Kimi K3 → 回车
   - 验证：弹出 "Kimi 需要 API Key" 输入框
   - 粘贴 Key → 回车 → 切换成功

6. **Ollama 未安装场景**:
   - 在没有 Ollama 的机器上启动
   - ConfigWizard: 选择本地模型 → 显示 "❌ 未安装" 提示

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: final verification — all tests pass, lint clean"
```

---

## 实现顺序依赖

```
Task 1 (constants + preset)     ← 无依赖，先做
    ↓
Task 2 (listModels dynamic)     ← 依赖 Task 1
    ↓
Task 3 (ConfigWizard UI)        ← 依赖 Task 1
    ↓
Task 4 (writeConfigFile fix)    ← 依赖 Task 1, Task 3
    ↓
Task 5 (/ollama-refresh)        ← 依赖 Task 1, Task 2
    ↓
Task 6 (API Key 补录)           ← 无硬依赖，独立改动
    ↓
Task 7 (E2E 验证)               ← 依赖所有 Task
```

Task 5 和 Task 6 可以并行。
