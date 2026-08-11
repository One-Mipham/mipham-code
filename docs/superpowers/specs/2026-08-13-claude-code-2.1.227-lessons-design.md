# Claude Code 2.1.227 借鉴设计

> 日期: 2026-08-13
> 来源: Claude Code 2.1.227 更新日志分析
> 状态: 已批准，待实现

## 概述

借鉴 Claude Code 2.1.227 三个改进方向：
1. ripgrep 搜索行为 prompt 增强（首优先）
2. 斜杠命令菜单匹配高亮
3. 性能排查（事件循环卡顿）

## 一、ripgrep Prompt 增强

### 背景

Claude Code 2.1.227 新增 ripgrep 工具描述文件，明确标注 rg 为推荐搜索工具，prompt token 涨了 10,000（+10%）。核心哲学：**把模糊偏好变成精确指令**，从"你可以用 grep 或 rg"变成"搜东西就用 rg"。

### Mipham Code 现状

- `grep.ts` 工具已用 `rg` 为主、`grep` 为 fallback（功能正确）
- 工具描述仅一行，未向 AI 传达使用偏好和最佳实践
- 系统提示中无搜索行为规范

### 方案

**① 增强 Grep 工具描述** (`apps/cli/src/tools/file/grep.ts`)

从一句话扩展为结构化描述，涵盖：主力引擎（rg）、何时用、最佳实践、fallback 机制。

**② 系统提示新增"Code Search Conventions"块** (`apps/cli/src/core/instructions.ts`)

沿用现有硬编码指令块模式（Critical Thinking Self-Check、Workflow Auto-Generation），新增搜索规范块。

**Token 预算**: ~500-800 tokens（Claude Code 方案的 5-8%）

## 二、斜杠命令菜单匹配高亮

### 现状

- `command-picker.tsx` 无字符级匹配高亮
- 选中行：▶ + 青色 + 加粗
- 匹配字符：无特殊标记

### 方案

将命令名按匹配字符拆分为多个 Text 节点，匹配部分加粗/下划线，非匹配部分保持默认。

## 三、性能排查

检测 `input.tsx` 中文件未找到建议和 @-mention 大小检查是否存在同步阻塞导致事件循环卡顿。

---

### 修订历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-08-13 | 初版 |
