# Mipham Code × Obsidian Wiki 集成（议题四）

> **版本**: 1.0.0
> **日期**: 2026-08-20
> **状态**: MCP 接入已落地并验证；`/save` 工作流 skill 待决策
> **参考**: claude-obsidian 插件（`~/MiphamAI`）、`@zethictech/obsidian-mcp` v1.1.7

---

## 一、目标

让 Mipham Code 读写用户**已有的** Obsidian wiki vault（`~/MiphamAI`），并评估是否提供「对话 → wiki note」的高层保存工作流。

**背景（why）**：用户是科研人员，有一个 Obsidian vault `~/MiphamAI`——它同时是一个 **claude-obsidian 插件**（`commands/` `agents/` `skills/` `scripts/` 一整套 Claude Code 生态）。在 Mipham Code 里测试时产生两个观察：

1. 自测提到 "Vault - MiphamAI"，疑似已有读 vault 能力。
2. 斜杠命令不识别 `/save`。

由此引出三个问题：

1. 能否像 Claude Code 那样安装 Obsidian 插件/skills？
2. 装上后能否建 vault + 得到 wiki 斜杠命令？同名是否冲突？
3. 能否继承/共享/识别本地已有 vault，不从头重建？

**非目标（范围外）**：

- 不做「重建 vault」——一律复用现有 `~/MiphamAI`。
- 不移植 claude-obsidian 的 agents/hooks（那是 Claude Code 生态，Mipham Code 无对应运行时）。
- 不承诺 Obsidian 图谱/画布（canvas）等 Obsidian 专属能力——那是 Obsidian App 的功能，MCP 只给文件级读写。

---

## 二、关键结论（带证据）

| #   | 结论                                                                    | 证据                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Mipham Code 无 "Vault - MiphamAI" 引用、无任何 obsidian 引用            | `apps/cli/src` 全文 grep 零 `obsidian`；所有 "Vault" 均为 **"LoopKit Vault"**（`src/commands/loop-scaffold.ts`，`/loop init` 在 `.mipham/` 下搭的**项目脚手架**，与 Obsidian vault 无关）                                                                                                                                                    |
| 2   | `/save` 是 claude-obsidian 的 **Claude Code 命令**，非 Mipham Code 命令 | `~/MiphamAI/commands/save.md`（同目录 `/wiki` `/autoresearch` `/canvas`）；Mipham Code 斜杠命令是静态 registry（`src/ui/commands.ts` `registry.set` + `COMMAND_DESCRIPTIONS`），不读 `~/MiphamAI/commands/`                                                                                                                                  |
| 3   | Mipham Code 有完整记忆体系，只是不叫 `/save`                            | `/memory`（`commands.ts:4823`）+ Memory 工具（`src/tools/agent/memory.ts`，读写 `~/.mipham/memory/`）+ AutoMemoryEngine（`engine.ts:616` 接入主循环）+ `/dream` 后台巩固                                                                                                                                                                     |
| 4   | claude-obsidian **目录插件装不上**                                      | 三处硬不兼容：① `skills/<name>/SKILL.md` 子目录格式 vs `SkillsLoader.loadDirectory` 只扫顶层扁平 `*.SKILL.md`（不递归）；② 插件 = skills+commands+agents+scripts+hooks 打包，Mipham Code 的「插件」= npm 包（`plugin-registry.ts`）；③ skill 用 `.vault-meta/`、`scripts/`、`../` 相对路径，假定 CWD=vault 目录，而 Mipham Code CWD=用户项目 |
| 5   | 通用 Obsidian 接入 = **MCP**，且 Mipham Code 已具备客户端               | `src/mcp/client.ts` 实现 `StdioTransport` + `HttpTransport` 双通道，协议 `2024-11-05`；`McpServerConfig`（`shared/types.ts`）`command`+`args`+`env`(stdio) / `url`+`headers`(HTTP)                                                                                                                                                           |

---

## 三、设计决策

| 维度       | 选择                                                                                 | 理由                                                                                        |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 接入方式   | **MCP stdio**（非目录插件、非文件系统）                                              | 协议标准、Mipham Code 已内置客户端；目录插件无加载器，文件系统缺 Obsidian 感知              |
| MCP server | `@zethictech/obsidian-mcp` v1.1.7（20 读 + 9 写 + 5 破坏性 = 34 工具 + 5 prompt）    | 包装官方 Obsidian CLI（1.12+）；MIT；Zod 运行时校验                                         |
| vault 定位 | `OBSIDIAN_VAULT=MiphamAI`（**vault 名**，或 ID）                                     | 显式指向，**天然认现有 vault、不重建**（对应问题 3）                                        |
| 前置条件   | Obsidian 1.12+ 开 CLI + app 运行                                                     | 已满足：版本 1.12.7、`obsidian.json` 里 `"cli": true`、`MiphamAI` `open: true`              |
| 同名冲突   | 无（`save`/`wiki`/`think`/`canvas` 均不在 `checkSkillShadow` 的 `BUILTIN_COMMANDS`） | 但冲突机制薄：skill-vs-skill 同名 = `Map.set` 静默覆盖；skill-vs-命令只认固定清单（见 §六） |
| 记忆体系   | Mipham Code 记忆（`~/.mipham/memory/`）与 wiki（`~/MiphamAI/wiki/`）**暂不打通**     | 两套并行；是否互认留作 `/save` skill 决策时的子问题                                         |

---

## 四、已落地（本次验证 + 接线）

1. **握手实测**：`initialize` 协议协商 `2024-11-05`（与 Mipham Code 客户端一致）、`tools/list` 返回 34 工具、`list_files` 返回真实 vault 文件（`AGENTS.md`、`agents/verifier.md`、`_templates/…`）→ 现有 vault 完全可达。
2. **配置接线**：`~/.mipham/mcp.json` 新增：

   ```json
   {
     "mcpServers": {
       "obsidian": {
         "command": "npx",
         "args": ["-y", "@zethictech/obsidian-mcp"],
         "env": { "OBSIDIAN_VAULT": "MiphamAI" }
       }
     }
   }
   ```

3. **加载机制**：`src/config/loader.ts:172 loadMcpJson()` 扫描用户级 `~/.mipham/mcp.json`（Claude Code 约定），启动时并入 `config.skills.mcpServers`；重启 Mipham Code 后 `/mcp` 可见。
4. **已知瑕疵**（非阻塞）：`get_vault_info` 报 `Command "vault" not found`——第三方包 bug（调了不存在的 `obsidian vault` 命令；CLI 里 `vault` 是选项 `vault=<name>` 而非命令）。影响 1/34 工具。

---

## 五、待决策：`/save` 工作流 skill（C 方向）

通用 MCP 给的是**底层读写 note** 能力，**不含** claude-obsidian 的「分析对话 → 归档成 wiki note」高层工作流。若要补齐：

- **方案 C1（MCP 版）**：一个 Mipham Code skill（如 `save-to-wiki`），复用 MCP 的 `create_note`/`append_note`/`set_property` 工具，流程：分析对话 → 判定 note 类型（concept/entity/decision/session）→ 生成 frontmatter → 写 `~/MiphamAI/wiki/` → 更新 index/hot。依赖已接的 MCP。
- **方案 C2（文件系统直连版）**：零 MCP 依赖，Read/Write/Glob 直接读写 `~/MiphamAI/wiki/`，复用 claude-obsidian 的 `save` skill 逻辑（`wiki-lock.sh` flock 锁 + 相对路径需改为绝对路径）。
- **子问题**：是否让 Mipham Code 记忆（`~/.mipham/memory/`）与 wiki 互认（双向同步或单向写入）。

> 建议 C1（复用已接 MCP，改动最小、有 Obsidian 感知）；但需先决定「记忆 ↔ wiki」关系再动手。

---

## 六、顺带发现（待清理，非本议题阻塞）

1. **`userInvocable` 死字段**：`types.ts:487` 定义、`loader.ts:185` 读取，但全 `src/` **零消费点**——skill 不会因 `user-invocable: true` 变成 `/name` 斜杠命令。CLAUDE.md 所述「可 /<name> 调用」与实现不符。
2. **`checkSkillShadow` 疑似 bug**：`BUILTIN_COMMANDS` 存的是 `/help` 带斜杠，而 `skillName` 不带斜杠，`Set.has(skillName)` 永不命中——skill 名与内置命令的冲突检测实际失效（description 检测走 `cmd.replace(/\//g,'')` 是对的，name 检测不对）。

---

## 七、结论

「装 claude-obsidian 插件」不可行（目录插件格式不兼容），但「装通用 Obsidian」可行且已落地：走 MCP 标准协议，Mipham Code 客户端现成，显式指向现有 `~/MiphamAI` vault，无需重建。剩余唯一工程点是可选的 `/save` 高层工作流（§五），取决于「Mipham Code 记忆 ↔ wiki」是否要打通。
