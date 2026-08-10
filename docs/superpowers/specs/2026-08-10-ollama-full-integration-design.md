# Ollama 完整集成设计

> **日期**: 2026-08-10
> **状态**: 设计中
> **版本**: 1.0.0

---

## 一、背景与目标

Mipham Code 已经在 ConfigWizard 中有了 Ollama 本地模型的基本入口，但存在三个缺口：

1. Ollama 未注册为正式 provider，不在 `DEFAULT_PROVIDERS` 中
2. ConfigWizard 的 Ollama 步骤只展示模型名文本，用户需手动输入（无交互选择）
3. 进入对话后，`/models` 命令和 `Ctrl+P` ModelPicker 无法列出 Ollama 模型

**目标**：Ollama 成为与云端 provider 同等待遇的一等公民——配置时可交互选择模型，对话中可热切换。

---

## 二、设计范围

### 2.1 改动文件

| 文件                                      | 改动                                  | 行数估计 |
| ----------------------------------------- | ------------------------------------- | -------- |
| `apps/cli/src/shared/constants.ts`        | 新增 Ollama provider 条目             | +15      |
| `apps/cli/src/shared/constants.ts`        | 抽取预置模型常量                      | +10      |
| `apps/cli/src/providers/openai-compat.ts` | `listModels()` Ollama 动态发现        | +25      |
| `apps/cli/src/ui/config-wizard.tsx`       | Ollama 步骤：TextInput → 列表选择     | +30      |
| `apps/cli/src/ui/config-wizard.tsx`       | `writeConfigFile()` Ollama 补全配置   | +20      |
| `apps/cli/src/ui/commands.ts`             | 新增 `/ollama-refresh` 命令           | +15      |
| `apps/cli/src/ui/commands.ts`             | `/switch` 增加 API Key 缺失检测与提示 | +25      |
| `apps/cli/src/ui/picker.tsx`              | ModelPicker 切换时 API Key 补录弹窗   | +20      |
| `apps/cli/test/ui/config-wizard.test.ts`  | 增量更新测试（ollama 模型选择交互）   | +30      |

### 2.2 不改动文件

- `/models` 命令 — 零改动（自动继承 config.providers）
- `ModelPicker` (Ctrl+P) — 零改动
- `ProviderRegistry` — 零改动
- `bootstrap.ts` — 零改动（Ollama 走 `openai-compatible` 协议）

---

## 三、详细设计

### 3.1 Provider 注册

**`shared/constants.ts`** — 在 `DEFAULT_PROVIDERS` 数组中新增：

```typescript
{
  id: 'ollama',
  name: 'Ollama (本地)',
  protocol: 'openai-compatible',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'ollama-local',
  models: [],  // 动态发现，初值为空
}
```

`apiKey: 'ollama-local'` 为占位符——Ollama 不校验 Authorization header，但 `ProviderConfig` 接口要求此字段。`baseUrl` 指向 Ollama 默认端口，用户可通过 config.yml 覆盖。

### 3.2 预置模型列表

新增常量 `OLLAMA_PRESET_MODELS`：

```typescript
const OLLAMA_PRESET_MODELS = [
  { id: 'om-V5-Flash', source: 'MiphamAI' },
  { id: 'om-V5-Pro', source: 'MiphamAI' },
  { id: 'om-V5-Visual', source: 'MiphamAI' },
  { id: 'om-V5-Apex', source: 'MiphamAI' },
  { id: 'deepseek-r1:70b', source: '热门' },
  { id: 'deepseek-v3', source: '热门' },
  { id: 'qwen2.5:72b', source: '热门' },
  { id: 'qwen3', source: '热门' },
]
```

与 `ollama list` 结果合并去重（按模型 ID），在 UI 中标注来源标签 `[MiphamAI]` / `[热门]`。

### 3.3 动态模型发现

**`providers/openai-compat.ts`** — `listModels()` 方法：

```
listModels():
  if (this.config.id === 'ollama'):
    installed = execSync('ollama list') → 解析模型名列表
    all = installed ∪ OLLAMA_PRESET_MODELS（按 id 去重）
    return all.map(name → ModelInfo({
      id: name,
      name: name,
      providerId: 'ollama',
      contextWindow: 128_000,
      maxOutput: 32_000,
      vision: false,
      status: 'active',
    }))
  // 原有逻辑不变
  return this.config.models.filter(m → m.status === 'active')
```

注意：`contextWindow` 和 `vision` 为默认值——Ollama 不提供这些元数据。用户如需精确值可在 config.yml 中手动指定。

### 3.4 ConfigWizard — Ollama 步骤

**当前**：`TextInput` 自由输入

**改为**：箭头键列表选择（与 Cloud provider/model 步骤交互一致）

```
┌──────────────────────────────────────────────┐
│ Ollama 本地模型配置：                         │
│                                              │
│ 状态：✅ 已安装 · 运行中                      │
│                                              │
│ 已下载模型（↑↓ 选择 · Enter 确认）：          │
│                                              │
│   ▶ qwen2.5:7b                               │
│     llama3.2:latest                          │
│     deepseek-r1:8b                           │
│     ─────────────────                        │
│     om-V5-Flash              [MiphamAI]      │
│     om-V5-Pro                [MiphamAI]      │
│     om-V5-Visual             [MiphamAI]      │
│     om-V5-Apex               [MiphamAI]      │
│     deepseek-r1:70b          [热门]          │
│     deepseek-v3              [热门]          │
│     qwen2.5:72b              [热门]          │
│     qwen3                    [热门]          │
│                                              │
│ Enter 确认 · Esc 返回                        │
└──────────────────────────────────────────────┘
```

**交互规则**：

- `↑↓` 移动光标
- `Enter` 选中 → 跳转 confirm 步骤
- `Esc` 返回 mode 选择
- 如果 Ollama 未安装 → 显示 "❌ 未检测到 Ollama，请先安装"
- 如果 `ollama list` 为空 → 仅显示预置模型列表 + 提示 "请先运行 ollama pull <model>"

**实现要点**：

- 新增 `ollamaCursor` state，与现有 `cursor` 分离（Ollama 步骤使用独立 cursor）
- 移除 `ollamaModel` 的 TextInput，改为列表导航
- 选中后 `setOllamaModel(selectedModelId)`

### 3.5 ConfigWizard — 配置写入

**`writeConfigFile()` 对 Ollama 特殊处理**：

生成的 config.yml：

```yaml
providers:
  - id: ollama
    name: Ollama (本地)
    protocol: openai-compatible
    baseUrl: http://localhost:11434/v1
    apiKey: ollama-local
    models:
      - id: qwen2.5:7b
      - id: llama3.2:latest
      - id: om-V5-Flash
      - id: om-V5-Pro
      - id: om-V5-Visual
      - id: om-V5-Apex
      - id: deepseek-r1:70b
      - id: deepseek-v3
      - id: qwen2.5:72b
      - id: qwen3
```

models 列表 = `ollama list` 结果 ∪ 预置模型（去重）。

### 3.6 运行时模型刷新

**新增 `/ollama-refresh` 命令**：

```
/ollama-refresh
  → 执行 ollama list
  → 合并预置模型（去重）
  → 更新 ProviderRegistry 中 Ollama 的 config.models
  → 输出刷新结果（新增 X 个，移除 Y 个）
```

命令注册在 `Model & Provider` 分类下。

### 3.7 `/models` 和 ModelPicker — 展示层零改动

Ollama 一旦在 `DEFAULT_PROVIDERS` 中注册，且 config.yml 中包含完整 models 列表，`/models` 和 `Ctrl+P` 自动展示 Ollama 模型。展示层无需任何代码改动。

### 3.8 运行时 API Key 补录（/switch + ModelPicker）

**场景**：用户初次配置选了 Ollama，对话中通过 `/switch` 或 `Ctrl+P` 切换到云端模型（如 Kimi K3）时，该 provider 的 API Key 可能还未配置（仍是 `${KIMI_API_KEY}` 占位符或空值）。

**流程**：

```
用户在对话中
  └─ /switch kimi kimi-k3  或  Ctrl+P → 选择 Kimi K3
      └─ 检测 apiKey 是否为未配置状态
          │
          ├─ 占位符/空值 → 🔑 弹出输入提示：
          │   "Kimi (月之暗面) 需要 API Key"
          │   "🔑 [TextInput: 粘贴 API Key 后按 Enter]"
          │   └─ 用户输入 → 回车
          │       ├─ 写入 config.yml（更新该 provider 的 apiKey）
          │       └─ 执行切换 ✅
          │
          └─ 已有有效 Key → 直接切换 ✅
```

**API Key "未配置"判断**：

- `apiKey` 为空字符串
- `apiKey` 匹配 `${...}` 占位符模式（如 `${KIMI_API_KEY}`）
- `apiKey === 'ollama-local'`（Ollama 占位符，不需要补录）

**切换入口覆盖**：

| 入口                         | 改动                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `/switch <provider> <model>` | `commands.ts` — `switchCmd` 增加 apiKey 检测，未配置时返回 prompt 要求用户输入 |
| `Ctrl+P` ModelPicker         | `picker.tsx` — 选中模型后检测 apiKey，未配置时内联弹出 TextInput               |

**配置持久化**：

- API Key 写入 `~/.mipham/config.yml`，使用 YAML 原位更新（保留其他配置不变）
- 后续切换到同一 provider 的其他模型不再提示

**Ollama 除外**：Ollama 的 `apiKey: 'ollama-local'` 视为"无需 API Key"，不触发补录流程。

---

## 四、边界情况

| 场景                                        | 处理                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Ollama 未安装                               | ConfigWizard 显示 ❌ 未安装提示，不阻塞流程                         |
| `ollama list` 返回空                        | 仅显示预置模型列表                                                  |
| 用户选择预置模型但本地未下载                | 显示提示 "该模型尚未在 Ollama 中下载，切换到该模型时将尝试自动拉取" |
| Ollama 服务未运行                           | 显示 "已安装但未运行，请执行 ollama serve"                          |
| 对话中 Ollama 服务挂掉                      | `OpenAICompatProvider` 现有错误处理捕获（连接拒绝 → 友好错误消息）  |
| config.yml 中已有旧 Ollama 配置             | `mergeProviders` 用 DEFAULT_PROVIDERS 中的新条目覆盖                |
| 切换到云端模型但 API Key 为空               | 弹出 TextInput 补录，写入 config.yml 后切换                         |
| 切换到云端模型但 API Key 为 `${VAR}` 占位符 | 同上，视为未配置                                                    |
| 切换到 Ollama 模型                          | 不触发 API Key 补录（`ollama-local` 视为免 Key）                    |
| 用户取消 API Key 输入（Esc）                | 放弃切换，保持当前 provider/model 不变                              |

---

## 五、测试策略

1. **ConfigWizard 状态机测试** — Ollama 步骤新增交互：列表导航、选中确认、Esc 返回
2. **`checkOllama()` 单元测试** — 模拟 ollama 安装/未安装/运行中/无模型 四种状态
3. **`listModels()` Ollama 动态发现测试** — 模拟 `ollama list` 输出解析
4. **`/ollama-refresh` 命令测试** — 验证模型列表更新
5. **API Key 补录流程测试** — `/switch` 和 ModelPicker 未配置 Key 时弹窗、输入后切换成功、Esc 取消
6. **已有测试回归** — 34 个 ConfigWizard 测试确保全部通过

---

## 六、不改动的范围

- Ollama 不需要专用 provider 协议（`openai-compatible` 已覆盖）
- 不引入 `ollama pull` 自动下载（超出范围——用户自己管理模型）
- 不改变 `DEFAULT_PROVIDERS` 中其他 9 个 provider 的任何配置
