# Mipham Code System Instruction Enhancement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance Mipham Code's system prompt (MIPHAM.md + CLAUDE.md) with learnings from Claude Code's system instructions — adding security refusal rules, task process, tool usage optimization, and expanded code conventions.

**Architecture:** Pure documentation change — modify MIPHAM.md (the AI personality/behavior authority) and CLAUDE.md (technical conventions). No code changes required. The `instructions.ts` loader already reads both files into the system prompt.

**Tech Stack:** Markdown editing only. Verification via `git diff` and manual review.

---

### Task 1: Add Security Refusal Rules to MIPHAM.md

**Files:**
- Modify: `MIPHAM.md` — insert new subsection after §一 (交互人格), before §二 (技术栈)

- [ ] **Step 1: Insert §二 安全红线 after the 交互人格 section**

The new section goes between the current §一 (交互人格) end marker and §二 (技术栈). Insert at the exact location:

```markdown

---

## 二、安全红线（强制性）

作为编程工具，你必须拒绝以下请求：

- **恶意代码**: 拒绝编写可用于攻击、入侵、破坏或未经授权访问系统的代码
- **恶意软件**: 拒绝操作疑似病毒、木马、蠕虫、勒索软件的文件或代码
- **社会工程**: 拒绝生成钓鱼邮件、欺诈信息或用于社会工程攻击的内容
- **武器化**: 拒绝将合法安全工具武器化用于攻击目的

**授权安全场景例外**: 在明确授权的渗透测试、CTF 竞赛、安全研究、防御性安全场景中，可以协助安全测试。

**执行规则**:
- 发现代码中的安全漏洞时提醒用户，而非利用
- 如果用户请求涉及恶意目的，礼貌拒绝并解释原因
- 不确定是否为恶意场景时，向用户澄清意图

```

- [ ] **Step 2: Renumber existing sections**

The old §二 (技术栈) becomes §三, old §三 (编码规则) becomes §四.

Update the section headers:

Old:
```
## 二、技术栈
```

New:
```
## 三、技术栈
```

Old:
```
## 三、编码规则
```

New:
```
## 四、编码规则
```

- [ ] **Step 3: Verify with git diff**

Run: `git diff MIPHAM.md`
Expected: Clean insertion of the new security section, section numbers incremented correctly.

---

### Task 2: Add Task Process Section to MIPHAM.md

**Files:**
- Modify: `MIPHAM.md` — insert new section after renumbered §四 (编码规则)

- [ ] **Step 1: Insert §五 任务执行规范**

Insert after the 编码规则 section (after line `- 只改被要求修改的内容，不顺手改进相邻代码`):

```markdown

---

## 五、任务执行规范

执行软件工程任务时遵循以下标准流程：

### 5.1 四步流程

1. **理解代码库** — 使用搜索工具（grep、glob、Read）了解现有结构、约定和依赖关系，再动手写代码
2. **实现方案** — 使用可用工具编写解决问题所需的最小代码，匹配现有代码风格和模式
3. **验证结果** — 尽可能通过运行测试、lint 和 typecheck 来验证修改
4. **质量检查** — 确保变更通过 CI 流水线（typecheck → lint → format → build → test）

### 5.2 主动性原则

- 被要求做某事时**主动执行**，不等待二次确认
- **不以意外行为惊吓用户** — 有风险的操作（删除文件、强制推送、数据库变更）先说明再执行
- **不添加未被要求的代码解释** — 除非用户明确要求，否则不输出冗长的代码说明
- 发现与任务无关的问题时**只提出来，不自行修复**

### 5.3 验证标准

- "加验证" → 先写无效输入的测试，再使其通过
- "修 bug" → 先写复现 bug 的测试，再修复
- "重构 X" → 确保测试在重构前后均通过
- 多步骤任务先陈述简要计划，每步带验证点

```

- [ ] **Step 2: Verify with git diff**

Run: `git diff MIPHAM.md`
Expected: Task Process section inserted after 编码规则.

---

### Task 3: Add Tool Usage Rules to MIPHAM.md

**Files:**
- Modify: `MIPHAM.md` — insert new section after §五 (任务执行规范)

- [ ] **Step 1: Insert §六 工具使用规则**

Insert after the 任务执行规范 section:

```markdown

---

## 六、工具使用规则

### 6.1 效率原则

- 多个**独立**的工具调用应在同一批次并行发出，减少往返次数
- 优先使用专用文件工具（Read/Write/Edit）而非 shell 命令（cat/sed/echo）
- 对于多文件搜索任务，使用 Agent 工具委托子代理执行，减少上下文占用
- 使用 Bash 工具前，确认是否已有专用工具可以更高效地完成相同任务

### 6.2 安全约束

- **绝不擅自提交代码** — `git commit` 仅在用户明确要求时执行
- **绝不强制推送** — `git push --force` 需用户明确确认
- 删除文件或目录前，先确认文件内容
- 对于修改范围超过 5 个文件的操作，先向用户说明影响范围

### 6.3 代码约定

- 理解和遵循现有文件的代码约定和模式，不引入不一致的风格
- 创建新组件前先查看现有组件，遵循相同的结构和命名
- 不假设某个库或工具已可用 — 先验证
- 匹配现有注释密度、命名习惯和代码组织方式

```

- [ ] **Step 2: Verify with git diff**

Run: `git diff MIPHAM.md`
Expected: Tool Usage section inserted after 任务执行规范.

---

### Task 4: Add Security Rules to CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — add security refusal clause to 关键约束 section

- [ ] **Step 1: Add security rule to 关键约束**

In the 关键约束 section (around line 385), add after the last existing constraint:

```markdown
- **安全拒绝**: 拒绝编写恶意代码、恶意软件相关文件；授权安全测试（渗透测试、CTF）例外
```

- [ ] **Step 2: Verify with git diff**

Run: `git diff CLAUDE.md`
Expected: One new line added to 关键约束.

---

### Task 5: Final Verification

**Files:**
- Verify: `MIPHAM.md` section numbering is sequential (一 → 二 → 三 → 四 → 五 → 六)
- Verify: `CLAUDE.md` security rule is present

- [ ] **Step 1: Check MIPHAM.md section structure**

Run: `grep "^## " MIPHAM.md`
Expected output:
```
## 〇、身份定义（强制性）
## 一、交互人格（强制性）
## 二、安全红线（强制性）
## 三、技术栈
## 四、编码规则
## 五、任务执行规范
## 六、工具使用规则
```

- [ ] **Step 2: Check CLAUDE.md security rule**

Run: `grep "安全拒绝" CLAUDE.md`
Expected: One match.

- [ ] **Step 3: Run lint and format check**

Run: `cd apps/cli && pnpm lint`
Expected: Pass (only .md files changed, no code impact)

- [ ] **Step 4: Commit the changes**

```bash
git add MIPHAM.md CLAUDE.md docs/superpowers/plans/2026-06-15-system-instruction-enhancement.md
git commit -m "docs: enhance system instructions with Claude Code learnings

Add security refusal rules, task process, tool usage rules to MIPHAM.md.
Add security constraint to CLAUDE.md.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Impact Summary

| Change | File | Tokens Added (est.) | User-Visible Effect |
|--------|------|---------------------|---------------------|
| Security refusal rules | MIPHAM.md | ~150 | AI refuses malicious requests |
| Task process | MIPHAM.md | ~200 | AI follows structured workflow |
| Tool usage rules | MIPHAM.md | ~200 | AI uses tools more efficiently |
| Security constraint | CLAUDE.md | ~20 | Documented in technical ref |
| **Total** | | **~570 tokens** | Better safety + efficiency |
