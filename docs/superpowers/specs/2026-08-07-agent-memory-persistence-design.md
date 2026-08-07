# Mipham Code — Agent Memory 持久化设计 Spec

> **版本**: 1.0.0
> **日期**: 2026-08-07
> **阶段**: Phase 7 — Agent Memory 持久化（三个子系统）
> **维护人**: One Mipham Corporation 技术委员会

---

## 一、目标

为 Mipham Code 实现完整的 Agent Memory 跨会话持久化，使 AI Agent 能在多次对话之间记住用户偏好、项目状态和历史决策。

三个子系统独立交付，共享底层 `MemoryManager`：

1. **Enhanced MemoryManager** — wikilinks + 去重 + SessionEnd 自动蒸馏
2. **Session Resume** — `/resume` 命令 + 自动摘要 + token 保护
3. **Agent Experience** — 成功/失败模式自动积累，越用越聪明

---

## 二、现有系统基线

| 组件             | 文件                            | 能力                                               |
| ---------------- | ------------------------------- | -------------------------------------------------- |
| `MemoryManager`  | `core/memory/memory-manager.ts` | CRUD 记忆文件、关键词召回、`buildSystemReminder()` |
| `MemoryLoader`   | `core/memory/memory-loader.ts`  | SessionStart 加载记忆注入 system-reminder          |
| `MemoryWriter`   | `core/memory/memory-writer.ts`  | 触发词检测（"记住"、"偏好"、"决策"）自动写入       |
| `MemoryTool`     | `tools/agent/memory.ts`         | AI 可调用的 read/write/list 工具                   |
| `SessionStore`   | `core/session-store.ts`         | JSONL 会话 save/load/list/delete                   |
| `AgentContext`   | `agent/agent-context.ts`        | Agent 三级 scope（user/project/local）加载静态 .md |
| `ContextManager` | `core/context.ts`               | 会话消息管理、压缩、checkpoint/rewind              |

**当前缺口**: 会话结束不自动记忆、无法恢复历史会话、Agent 不积累经验。

---

## 三、子系统 1 — Enhanced MemoryManager

### 3.1 增强的记忆文件格式

```
---
name: <kebab-case-slug>
description: <一句话摘要>
metadata:
  type: user | feedback | project | reference
  savedFrom: session-2026-08-07         # 🆕 来源追踪
---

<content>

**Why:** <原因>                              # 🆕
**How to apply:** <应用方式>                  # 🆕

See also: [[other-memory]] [[another]]        # 🆕 wikilinks 在内容体中
```

### 3.2 新增能力

#### 3.2.1 [[wikilinks]] 解析与图谱

```
MemoryManager:
  parseMemoryFile() → 提取 [[...]] → 更新 links.json 双向图
  getLinkedMemories(name) → 返回所有关联记忆
  recall() → 增加 wikilink 追踪：A 链接 B，匹配 A 时也返回 B（加权 -1）
```

`links.json` 结构：

```json
{
  "phase-4-complete": ["phase-5-next-steps", "service-mesh"],
  "phase-5-next-steps": ["phase-4-complete", "nexus-sentinel"]
}
```

#### 3.2.2 结构化段落支持

`formatMemoryFile()` 接受可选参数 `{ why, howToApply }`，自动生成对应段落。

#### 3.2.3 去重写入

`write()` 调用前：

1. 检查已有记忆中是否存在相同 `name` → 更新内容，保留旧 links
2. 检查 description 文本相似度 > 0.7（简单 Jaccard） → 视为重复，跳过写入

#### 3.2.4 SessionEnd 蒸馏钩子

新增 `distillFromSession(summary: string)` 方法：

- 接收会话退出时由 LLM 生成的摘要文本
- 从中提取要点（按 `**Why:**` / `**How to apply:**` 标记分段）
- 每个要点创建一个独立 memory 文件
- 自动添加 `savedFrom: session-<id>` metadata

#### 3.2.5 改进召回

`recall()` 评分算法增强：

| 匹配方式                     | 权重       |
| ---------------------------- | ---------- |
| 关键词匹配 relevance tags    | +3         |
| 内容词匹配（>3 chars）       | +1         |
| wikilink 追踪（间接关联）    | +1 per hop |
| 时间衰减（>30天的记忆 ×0.5） | 衰减因子   |

### 3.3 改动文件

| 文件                            | 改动                                               | 行数 |
| ------------------------------- | -------------------------------------------------- | ---- |
| `core/memory/memory-manager.ts` | wikilinks 解析、去重、召回增强、distillFromSession | +~80 |
| `core/memory/memory-loader.ts`  | 适配新字段                                         | +~10 |

### 3.4 测试

- 记忆去重：同名更新、相似描述跳过
- wikilink 图谱：创建→查询双向关联→召回包含间接链接
- SessionEnd 蒸馏：摘要输入→正确拆分为多个记忆文件
- 时间衰减：30 天前记忆得分减半

---

## 四、子系统 2 — Session Resume

### 4.1 增强的会话目录

```
~/.mipham/sessions/
├── session-2026-08-07T14-30-00.jsonl    # 完整消息历史（已有）
├── .index.json                           # 🆕 快速索引
└── .summaries/                           # 🆕 会话摘要缓存
    └── session-2026-08-07T14-30-00.md
```

`.index.json` 结构：

```json
[
  {
    "name": "session-2026-08-07T14-30-00",
    "createdAt": "2026-08-07T14:30:00+08:00",
    "updatedAt": "...",
    "provider": "deepseek",
    "model": "deepseek-v4-pro",
    "messageCount": 87,
    "tokenCount": 45000,
    "cwd": "/path/to/mipham-code",
    "summary": "讨论 Phase 7 Agent Memory 持久化设计",
    "tags": ["phase-7", "agent-memory", "design"]
  }
]
```

### 4.2 新增能力

#### 4.2.1 `/resume` 命令

```
/resume             → 打开 Picker，列出最近 10 个会话（摘要 + 时间 + model）
/resume last        → 直接恢复上次会话
/resume <name>      → 恢复指定会话
/resume delete <n>  → 删除会话
```

**恢复流程:**

```
1. SessionStore.load(name) → 获取完整消息历史
2. 检查 tokenCount，若 > ContextManager.maxTokens * 0.8:
   a. 保留首条 system prompt + 最后 20 条消息
   b. 中间消息压缩为摘要注入
3. ContextManager.replaceMessages(messages)
4. 注入恢复提示: "已恢复会话 <name>（87 条消息）"
```

#### 4.2.2 自动摘要

会话退出时（`engine.ts` 退出流程）：

```
1. 取最后 5 轮对话（user + assistant）
2. 调用模型生成一句话摘要 + 3-5 个标签
3. 存入 .index.json + .summaries/
4. 触发 MemoryManager.distillFromSession() 蒸馏长期记忆
```

#### 4.2.3 SessionStart 注入

引擎启动时：

```
1. 读取 .index.json
2. 找到最近一次会话
3. 注入到 system prompt:
   "[系统] 你上次与用户的对话（2026-08-07）: 讨论 Phase 7 Agent Memory 持久化设计。
    输入 /resume last 恢复完整上下文。"
```

### 4.3 改动文件

| 文件                    | 改动                                                                    | 行数 |
| ----------------------- | ----------------------------------------------------------------------- | ---- |
| `core/session-store.ts` | 新增 `updateIndex()`, `saveSummary()`, `getLatest()`, 增强 token 元数据 | +~60 |
| `core/engine.ts`        | SessionStart 注入、退出摘要触发                                         | +~20 |
| `ui/commands.ts`        | 注册 `/resume` 命令                                                     | +~20 |

### 4.4 测试

- 会话保存 → 索引更新 → `/resume last` 正确恢复
- Token 超阈值的会话恢复 → 自动压缩后再载入
- 退出自动摘要 → `.index.json` 和 `.summaries/` 都有记录
- SessionStart 注入 → system prompt 包含上次会话提示

---

## 五、子系统 3 — Agent Experience Memory

### 5.1 经验文件格式

```
~/.mipham/agent-memory/
├── code-reviewer/
│   ├── experience.md        # 🆕 自动积累
│   └── manual.md            # 原有手动记忆（兼容）
├── debugger/
│   └── experience.md
└── ...

experience.md:
# Agent Experience — code-reviewer

## Success Patterns
- [2026-08-07] 发现 import 循环依赖 → glob 扫描 + Grep 验证
  **When to apply:** 涉及跨模块导入的 PR review
- [2026-08-06] 检测到未处理的 Promise rejection → 全局搜索 .catch() 模式
  **When to apply:** 异步代码审查

## Failure Patterns
- [2026-08-07] Bash 超时导致误判 → CI 构建命令不能用默认 120s timeout
  **When to avoid:** 涉及 npm install / docker build 的命令须加大 timeout
- [2026-08-06] Grep 搜索范围过大导致 token 溢出 → 先用 Glob 缩小范围
  **When to avoid:** 全仓库搜索前应先限定目录

## Stats
- 总执行: 47 次 | 成功: 41 | 失败: 6
- 平均 token: 12,000 | 平均耗时: 45s
- 最近执行: 2026-08-07 15:30
```

### 5.2 新增能力

#### 5.2.1 Agent 自记录

Agent 执行完成后（`sub-agent.ts` 退出流程）：

```
1. 判断结果: success / failure / error
2. 成功 → 提取:
   - 关键步骤（从工具调用序列中取前 3 个非平凡调用）
   - 结果摘要（最后一条消息的前 200 chars）
   - 追加到 Success Patterns
3. 失败 → 提取:
   - 错误消息 + 可能原因
   - 追加到 Failure Patterns
4. 更新 Stats 计数
5. 写入 experience.md（保留已有条目，最多保留 20 条经验）
```

#### 5.2.2 经验注入

Agent 下次启动时，`agent-context.ts` 在 `loadAgentMemory()` 中：

1. 加载 `manual.md`（用户手动写的，优先）
2. 加载 `experience.md` 的 Stats + 最近 5 条 Success + 最近 3 条 Failure
3. 注入到 system prompt 末尾

#### 5.2.3 `/agent reset <name>` 命令

清除指定 Agent 的 experience.md，保留 manual.md。

### 5.3 改动文件

| 文件                        | 改动                                        | 行数 |
| --------------------------- | ------------------------------------------- | ---- |
| `agent/agent-experience.ts` | **新文件** — 经验提取、格式读写、Stats 更新 | ~60  |
| `agent/sub-agent.ts`        | 执行结束时调用 `autoLogExperience()`        | +~30 |
| `agent/agent-context.ts`    | `loadAgentMemory()` 增加 experience.md 加载 | +~25 |

### 5.4 测试

- 经验记录：模拟成功/失败结果 → 验证 experience.md 正确追加
- 经验注入：加载 Agent context → system prompt 包含经验段落
- Stats 准确性：多次执行后计数正确
- 上限控制：超过 20 条最旧经验被移除

---

## 六、交付顺序与依赖

```
子系统 1 (MemoryManager)
    │
    ├── 子系统 2 (Session Resume) — 独立，但共享 distillFromSession()
    │
    └── 子系统 3 (Agent Experience) — 独立，但复用 MemoryManager 的文件模式
```

| 顺序     | 子系统                 | 改动量         | 测试增量      |
| -------- | ---------------------- | -------------- | ------------- |
| 1        | Enhanced MemoryManager | ~90 lines      | +4 tests      |
| 2        | Session Resume         | ~100 lines     | +4 tests      |
| 3        | Agent Experience       | ~115 lines     | +4 tests      |
| **合计** |                        | **~305 lines** | **+12 tests** |

---

## 七、风险与回滚

| 风险                | 缓解                                |
| ------------------- | ----------------------------------- |
| LLM 摘要质量不稳定  | 摘要失败时降级为简单截断前 200 字   |
| 经验文件无限增长    | 硬上限 20 条经验 + Stats 统计不增长 |
| 会话恢复 token 溢出 | 恢复前 token 检查 + 自动 compact    |
| wikilinks 图过大    | 限制单文件 10 个链接                |

所有新功能通过 feature flag 控制：

- `~/.mipham/config.json` 新增 `memory.autoDistill`, `memory.sessionResume`, `memory.agentExperience`
- 默认全部开启，用户可关闭

---

## 八、不做什么（明确排除）

- ❌ SQLite 后端 — 保持文件系统简单性
- ❌ 向量嵌入 — 过度工程化，关键词 + wikilinks 足够
- ❌ 跨设备同步 — 不在 Phase 7 范围
- ❌ 记忆导出/导入 — 可在后续版本添加
- ❌ Memory 可视化 UI — 已有 `/memory` 命令，后续增强

---

### 修订历史

| 版本  | 日期       | 变更内容                 | 维护人     |
| ----- | ---------- | ------------------------ | ---------- |
| 1.0.0 | 2026-08-07 | 初版：三个子系统完整设计 | 技术委员会 |
