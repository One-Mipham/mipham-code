---
name: self-audit
description: CRSI Phase 2: Mipham Code systematic self-audit — identifies code quality, architecture, performance, and security issues; integrates with CRSI pipeline for auto-rule generation
version: 1.0.0
---

# Self-Audit Skill (CRSI Phase 2)

> **定位**: CRSI Phase 2 "建议式代码自改" 的基石技能。
> 系统化审计 Mipham Code 自身代码库，生成结构化改进建议，
> 并接入 CRSI Phase 1 pipeline（PatternAnalyzer → RuleEngine → EffectivenessTracker）。

## 核心理念

Mipham Code 审计 Mipham Code — 这是 CRSI 递归自我改进的第一个闭环：

```
自读(Self-Read) → 自判(Self-Judge) → 建议(Propose) → 人审(Human Gate) → 实施(Apply)
```

本次审计是只读操作，不做任何代码修改。所有发现输出为结构化报告。

## 审计维度（6 维）

### 1. 代码质量

| 检查项       | 方法                                          |
| ------------ | --------------------------------------------- |
| Dead code    | Grep 搜索未被引用的 export、未使用的 import   |
| 不一致模式   | 对比同一目录下多个文件的代码风格/模式差异     |
| 类型安全     | 搜索 `as any`、`@ts-ignore`、`unknown` 未收窄 |
| 错误处理     | 搜索裸 `catch`、无 `try/catch` 的 async 调用  |
| Deep nesting | 搜索嵌套超过 4 层的 if/for/switch             |

### 2. 架构完整性

| 检查项      | 方法                                                       |
| ----------- | ---------------------------------------------------------- |
| 循环依赖    | 分析 import 图，检测 A→B→A                                 |
| 接口契约    | 对比 `shared/types.ts` 中的类型定义与实际使用              |
| 模块边界    | 检查是否有跨层级直接访问（ui/ 直接 import core/ 内部实现） |
| God objects | 搜索超过 500 行的单个类/函数                               |

### 3. 性能

| 检查项       | 方法                                            |
| ------------ | ----------------------------------------------- |
| 同步阻塞     | 搜索 `readFileSync`、`execSync` 在主线程中      |
| 内存泄漏风险 | 搜索未清理的 setInterval、EventEmitter listener |
| 渲染性能     | 检查 React memo/callback 使用是否完整           |
| N+1 模式     | 搜索在循环内的 I/O 操作                         |

### 4. 安全

| 检查项     | 方法                                     |
| ---------- | ---------------------------------------- |
| 硬编码凭据 | 搜索 API key、token、password 字符串     |
| 路径遍历   | 搜索使用用户输入的 `join`/`resolve` 路径 |
| 命令注入   | 搜索字符串拼接的 shell 命令              |
| 许可合规   | 检查 package.json 中的 copyleft 依赖     |

### 5. 测试覆盖

| 检查项          | 方法                                              |
| --------------- | ------------------------------------------------- |
| 未测试模块      | Glob 所有 `src/**/*.ts`，对比 `test/` 目录        |
| 关键路径覆盖    | 识别 engine、permission、tools 层，检查测试       |
| Flaky test 风险 | 搜索 `setTimeout`、`Math.random`、Date 依赖的测试 |
| 边界测试缺失    | 检查主要函数的 null/undefined/empty 参数测试      |

### 6. CRSI 集成健康

| 检查项          | 方法                                                  |
| --------------- | ----------------------------------------------------- |
| Rule 引擎状态   | 检查活跃规则数、禁用规则数、builtin vs auto-generated |
| 效果追踪        | 从 EffectivenessTracker 读取规则成功率                |
| 模式分析器      | 检查累积的 Agent 失败模式                             |
| AutoMemory 状态 | 检查复盘文件数量、CRSI 洞察统计                       |

## 执行流程

### Phase A: 快速扫描（1-2 分钟）

生成高层概览，回答"最需要关注什么？"

```
1. Glob 所有 .ts/.tsx 文件
2. 统计: 文件数、行数、测试数
3. 快速扫描: as any / @ts-ignore / 裸 console.log
4. 输出: 一句话总结 + Top 5 issues
```

### Phase B: 深度分析（5-10 分钟）

逐维度检查，生成详细报告。

```
1. 并行启动 6 个分析 agent（每维度一个）
2. 每个 agent 使用 glob/grep/read 进行系统化搜索
3. 收集发现 → 去重 → 排序（严重度 × 影响范围）
4. 输出: 结构化审计报告
```

### Phase C: CRSI 集成

将发现接入 CRSI pipeline。

```
1. 可自动修复的 → 调用 PatternAnalyzer.toToolRule() → RuleEngine.register()
2. 可自动测试的 → 生成测试用例建议
3. 需要人工判断的 → 输出到 ~/.mipham/memory/audit-*.md
4. 记录到 EffectivenessTracker 供后续追踪
```

## 输出格式

```markdown
# Mipham Code Self-Audit Report

**日期**: YYYY-MM-DD
**版本**: vX.Y.Z
**审计范围**: apps/cli/src/ (N files, M lines)

---

## 摘要

| 维度       | 评分 | 发现数 | 严重 |
| ---------- | ---- | ------ | ---- |
| 代码质量   | 7/10 | 12     | 2    |
| 架构完整性 | 8/10 | 3      | 0    |
| 性能       | 7/10 | 5      | 1    |
| 安全       | 8/10 | 2      | 0    |
| 测试覆盖   | 7/10 | 8      | 1    |
| CRSI 健康  | 9/10 | 0      | 0    |

## 🔴 严重 (需要立即处理)

1. **[file:line]** 问题描述 → 建议修复方案

## 🟡 改进建议

1. **[file:line]** 问题描述 → 建议修复方案

## 🟢 已自动修复 (CRSI Rule Generated)

1. **问题** → **生成的规则 ID** → **预期效果**

## CRSI 规则更新

| 规则 ID | 类型 | 状态                     | 上次评估 |
| ------- | ---- | ------------------------ | -------- |
| ...     | ...  | active/degraded/disabled | ...      |
```

## 安全约束

- **只读**: 此 skill 不做任何代码修改
- **不推送**: 不执行 `git push`
- **不部署**: 不触发 CI/CD
- **人控闸门**: 所有建议需人工审批后才能实施
- **沙箱建议**: 如需实际修改代码，应使用 git worktree 隔离

## 使用方式

```
/self-audit           # 快速扫描
/self-audit deep      # 深度分析（Phase B + C）
/self-audit crsi      # 仅 CRSI 集成健康检查
/self-audit report    # 查看最近的审计报告
```
