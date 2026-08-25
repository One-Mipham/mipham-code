---
name: mipham-code-setup
description: Install, configure, diagnose, and troubleshoot Mipham Code — the multi-model open-core intelligent coding terminal. Covers setup wizard, API keys, providers, models, skills, permissions, workspace trust, shell/IDE integration, and first-run onboarding.
version: 2.0.0
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Skill
---

# Mipham Code Setup — Executable Setup Workflow

**Type**: Rigid — follow the decision tree exactly. Don't skip diagnostic phases.

**Purpose**: Guide users from zero to fully configured Mipham Code. This skill is BOTH:

1. A self-contained diagnostic + configuration workflow the AI can execute
2. A reference for `/setup` command behavior and slash commands

**Triggers**: "setup mipham", "configure mipham", "install mipham code", "mipham not working", "mipham setup", "first time using mipham", "help me set up", "getting started", `/setup`

---

## Phase 0: Environment Detection (ALWAYS RUN FIRST)

Before doing anything, run these diagnostic checks. Report results in a status table.

### 0.1 — Detect Installation

```bash
which mipham 2>/dev/null
mipham --version 2>/dev/null
bun --version 2>/dev/null
node --version 2>/dev/null
```

### 0.2 — Detect Configuration

```bash
ls -la .mipham/config.yml 2>/dev/null
ls -la ~/.mipham/config.yml 2>/dev/null
ls -la MIPHAM.md 2>/dev/null
ls -la CLAUDE.md 2>/dev/null
```

### 0.3 — Detect API Keys

```bash
env | grep -E 'ANTHROPIC_API_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY|QWEN_API_KEY|DOUBAO_API_KEY|HUNYUAN_API_KEY|GEMINI_API_KEY' | cut -d= -f1
```

### 0.4 — Detect Skills & Permissions

```bash
ls .mipham/skills/ 2>/dev/null
cat .mipham/config.yml 2>/dev/null | grep -E 'permission|trust' || echo "no config"
```

### 0.5 — Detect Workspace Trust

```bash
cat ~/.mipham/trusted-workspaces.json 2>/dev/null || echo "no trust store"
```

### Status Report Format

After detection, present results as:

```
── Mipham Code Status ──

Installation:  [✅/⬜] mipham CLI  [✅/⬜] Bun  [✅/⬜] Node.js
Project:       [✅/⬜] .mipham/  [✅/⬜] config.yml  [✅/⬜] MIPHAM.md
User Config:   [✅/⬜] ~/.mipham/config.yml
API Keys:      [N] set (list names or "none")
Skills:        [N] installed
Permissions:   [mode] (default/acceptEdits/plan/bypassPermissions)
Trust:         [✅/⬜] workspace trusted
```

Then proceed to ONLY the phases where something is missing. Don't re-run already-configured steps unless asked.

---

## Phase 1: Installation

**Trigger**: `mipham --version` fails.

### Option A: Quick Install (recommended)

```bash
curl -fsSL https://mipham.ai/install.sh | bash
```

Then restart the shell or run:

```bash
export PATH="$HOME/.mipham/bin:$PATH"
```

### Option B: npm Global Install

```bash
npm install -g @miphamai/cli
mipham
```

### Option C: From Source (developers)

```bash
git clone https://github.com/One-Mipham/mipham-code
cd mipham-code/apps/cli
bun install && bun run bin/mipham
```

### ✅ Verification

```bash
mipham --version   # Should print version ≥ 0.24.0
mipham --help      # Should print usage
```

---

## Phase 2: Project Initialization

**Trigger**: Missing `.mipham/` directory or `MIPHAM.md`.

### 2.1 — Create .mipham/ directory

```bash
mkdir -p .mipham
```

### 2.2 — Create .mipham/config.yml

Write a minimal config. Ask the user which provider they want to use first, or pick a sensible default:

```yaml
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
permission: default
```

**Providers available** (alphabetical):

| Provider  | Type          | Example Models                         |
| --------- | ------------- | -------------------------------------- |
| anthropic | Native SDK    | Claude Haiku 4.5, Sonnet 4.6, Opus 4.8 |
| deepseek  | OpenAI Compat | V4 Flash, V4 Pro                       |
| doubao    | OpenAI Compat | Seed 1.6, Seed 2.0                     |
| gemini    | OpenAI Compat | 3.0 Flash, 3.0 Pro, 2.5 Pro            |
| hunyuan   | OpenAI Compat | Lite, TurboS, 2.0, T1                  |
| openai    | OpenAI Compat | GPT-5.4 Mini, GPT-5.4, GPT-5.5, Codex  |
| qwen      | OpenAI Compat | Qwen Plus, Qwen Max                    |

### 2.3 — Create MIPHAM.md (optional but recommended)

Create `MIPHAM.md` in project root to define AI personality:

```markdown
# MIPHAM.md

## Project Context

- **Project**: [name]
- **Language**: [zh-CN / en]
- **Stack**: [TypeScript / Python / etc.]

## Preferences

- Code style: [e.g., functional, OOP]
- Comment language: [e.g., English]
- Test framework: [e.g., Vitest]
```

### ✅ Verification

```bash
ls -la .mipham/config.yml MIPHAM.md
```

---

## Phase 3: API Key Configuration

**Trigger**: Missing API keys in environment.

### 3.1 — Identify Required Providers

Ask the user which providers they plan to use. For each, set the env var.

### 3.2 — Set API Keys

**Recommended: Environment variables** (not in config files — avoids accidental commits):

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."
export QWEN_API_KEY="sk-..."
export DOUBAO_API_KEY="..."
export HUNYUAN_API_KEY="..."
export GEMINI_API_KEY="..."
```

Add these to `~/.zshrc` or `~/.bashrc` for persistence:

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

**Alternative**: Store in `~/.mipham/config.yml`:

```yaml
providers:
  - id: anthropic
    apiKey: $ANTHROPIC_API_KEY
  - id: openai
    apiKey: $OPENAI_API_KEY
```

### 3.3 — Verify Keys

```bash
env | grep API_KEY
```

### ❗Security Rules

- NEVER hardcode API keys in project config files (`.mipham/config.yml` in project root should use `$ENV_VAR` references, not raw keys)
- NEVER commit API keys to git
- Add to `.gitignore`: `.mipham/config.yml` (if it contains keys), `.env`, `*.pem`

---

## Phase 4: Provider & Model Configuration

**Trigger**: Need to set default or enable/disable providers.

### 4.1 — Set Default Provider & Model

In `.mipham/config.yml`:

```yaml
defaultProvider: anthropic
defaultModel: claude-sonnet-4-6
```

Or use slash commands:

```
/model          # Interactive model picker (Ctrl+P)
/switch         # Switch provider
/providers      # List all configured providers
```

### 4.2 — Enable/Disable Providers

```yaml
providers:
  - id: anthropic
    status: active
  - id: openai
    status: active
  - id: deepseek
    status: disabled
```

### ✅ Verification

```
/model    # Should show available models
/providers # Should list active providers
```

---

## Phase 5: Skills Installation

**Trigger**: No or few skills installed.

### 5.1 — Built-in Skills

Mipham Code ships with 17 built-in skills loaded automatically:

- **Standard (14)**: code-review, compassionate-communication, doc-generator, github-ops, memory, mipham-code-setup, security-review, self-review, superpower, systematic-debugging, tdd, test-driven-development, web-access, web-search
- **Mipham (3)**: om-artifact, om-model-optimize, om-security

### 5.2 — Community Skills

Install from the community registry:

```
/setup 4     # Guided skill browser
```

Or directly:

```bash
# Skills are loaded from:
# - apps/cli/skills/standard/     (built-in standard)
# - apps/cli/skills/mipham/       (built-in mipham)
# - ~/.mipham/skills/             (user-installed)
# - .mipham/skills/               (project-local)
```

### 5.3 — Install Specific Skills

```
/skills install <name>    # Install from registry
/skills list              # List available
/skills search <query>    # Search registry
```

### ✅ Verification

```
/skills list   # Should show installed skills with counts
```

---

## Phase 6: Permissions Configuration

**Trigger**: Permission mode not configured or wrong for use case.

### 6.1 — Permission Modes

| Mode                | Behavior                        | Use Case                            |
| ------------------- | ------------------------------- | ----------------------------------- |
| `default`           | Prompt for each tool            | Normal development (recommended)    |
| `acceptEdits`       | Auto-allow edits, prompt others | Active coding sessions              |
| `plan`              | Plan-only, no tool execution    | Design & architecture work          |
| `bypassPermissions` | Skip all checks                 | ⚠️ Only for fully trusted codebases |

### 6.2 — Configure

In `.mipham/config.yml`:

```yaml
permission: default
```

Or via slash command:

```
/permissions           # View current settings
/setup 5               # Permission setup wizard
```

### 6.3 — CI/CD Safety

For CI/CD environments, use the `default` mode (the daemon default): headless
sessions never prompt, so `ask`-level tools (Bash/Write/Edit) are blocked rather
than auto-approved.

### ✅ Verification

```
/permissions   # Should show current mode
```

---

## Phase 7: Workspace Trust

**Trigger**: Untrusted workspace (prompted on startup in v0.24.3+).

### 7.1 — Understanding Workspace Trust

Workspace trust is a security mechanism that prevents AI from operating in untrusted directories. Trust is **hierarchical**: trusting `/Users/me/Projects` implicitly trusts all subdirectories.

### 7.2 — Trust a Workspace

**Interactive**: Accept the trust prompt when launching Mipham Code in a new directory.

**Manual**:

```
/trust              # Show trust status
/trust add <dir>    # Trust a directory
/trust remove <dir> # Revoke trust
```

### 7.3 — Trust Store

```
~/.mipham/trusted-workspaces.json
```

### 7.4 — Auto-Trust for Worktrees

When using git worktrees, Mipham Code automatically trusts worktree directories if the parent workspace is already trusted (via `EnterWorktree`).

### ✅ Verification

```
/trust   # Should show "✅ Yes" for current directory
```

---

## Phase 8: Shell & IDE Integration

**Trigger**: Want terminal integration, aliases, or IDE plugins.

### 8.1 — Shell Alias

Add to `~/.zshrc` or `~/.bashrc`:

```bash
alias mipham='cd ~/your-project && bun run ~/path/to/mipham-code/apps/cli/bin/mipham.ts'
# Or if installed globally:
alias mipham='mipham'
```

### 8.2 — VS Code Integration

Run `/ide` to auto-generate `.vscode/` config files:

- `settings.json` — terminal profile "mipham" using Bun
- `keybindings.json` — Cmd+Esc to focus terminal, Cmd+Shift+M for new terminal
- `extensions.json` — recommends `miphamai.mipham-code` extension

To use after generation:

1. Restart VS Code (or Cmd+Shift+P → Reload Window)
2. Open terminal: Ctrl+` or Cmd+Esc
3. Select "mipham" profile from terminal dropdown

Install the VS Code extension:

```bash
code --install-extension miphamai.mipham-code
```

### 8.3 — JetBrains Integration

Settings → Tools → Terminal → Shell path → `bun run mipham`

### 8.4 — Terminal Setup

```
/terminal-setup    # Shell & terminal config wizard
/setup 6           # Shell integration (part of full wizard)
```

### ✅ Verification

```bash
which mipham       # Should resolve
# In VS Code: Ctrl+` → select "mipham" profile
```

---

## Phase 9: Full Verification

Run after all configuration phases complete.

### 9.1 — System Diagnostics

```
/doctor            # System diagnostics check
```

### 9.2 — End-to-End Test

Start a conversation and verify:

1. Model responds (not stuck on "connecting...")
2. File tools work: "read CLAUDE.md"
3. Bash works: "list files in current directory"
4. Skills load: `/skills list`

### 9.3 — Common Issues & Fixes

| Symptom                   | Diagnosis                              | Fix                                              |
| ------------------------- | -------------------------------------- | ------------------------------------------------ |
| "Provider not registered" | Missing or invalid API key             | `env \| grep API_KEY`; check key format          |
| "Model not found"         | Model ID mismatch or disabled provider | `/models` to list available; `/switch` to change |
| Slow responses            | Large model, network, or context full  | `/fast on` or switch to Flash model; `/compact`  |
| Context full              | Too many messages in history           | `/compact` to compress; `/clear` to reset        |
| Permission denied         | Tool blocked by permission mode        | `/permissions` to check; adjust mode             |
| "Workspace not trusted"   | New directory, not yet trusted         | Accept startup prompt or run `/trust`            |
| MCP tools not available   | Server not connected                   | `/mcp connect <name>` or check config            |
| Update not applying       | Cached binary                          | `mipham update --force` then restart             |
| Config changes ignored    | YAML syntax error                      | Validate with `mipham --check-config`            |

### 9.4 — Get Help

```
/help              # Full command reference
/setup             # Re-run setup wizard
/doctor            # Run diagnostics
```

Chat-based help: "help me configure X" or "why isn't Y working?"

---

## Quick Reference: Essential Slash Commands

| Category      | Command           | Purpose                                                |
| ------------- | ----------------- | ------------------------------------------------------ |
| **Setup**     | `/setup`          | Full 6-step setup wizard                               |
|               | `/setup 1`        | Initialize project (.mipham/ + MIPHAM.md + config.yml) |
|               | `/setup 2`        | Configure providers & API keys                         |
|               | `/setup 3`        | Choose default model                                   |
|               | `/setup 4`        | Browse & install skills                                |
|               | `/setup 5`        | Configure permissions                                  |
|               | `/setup 6`        | Shell & IDE integration                                |
| **Diagnosis** | `/doctor`         | System diagnostics                                     |
|               | `/trust`          | Workspace trust status                                 |
|               | `/permissions`    | Tool permission settings                               |
| **Model**     | `/model`          | Interactive model picker (Ctrl+P)                      |
|               | `/switch`         | Switch provider                                        |
|               | `/models`         | List available models                                  |
| **Session**   | `/clear`          | Reset conversation                                     |
|               | `/compact`        | Compress context                                       |
|               | `/rename`         | Rename session                                         |
| **Workflow**  | `/plan`           | Enter plan mode                                        |
|               | `/review`         | Code review                                            |
|               | `/todos`          | Task list                                              |
| **IDE**       | `/ide`            | Generate VS Code integration files                     |
|               | `/terminal-setup` | Shell & terminal config                                |
| **Skills**    | `/skills list`    | List installed skills                                  |
|               | `/skills search`  | Search skill registry                                  |
|               | `/skills install` | Install a skill                                        |

---

## Post-Setup: What to Do Next

After configuration is verified:

1. **Initialize your project**: "help me understand this codebase"
2. **Set up CLAUDE.md**: `/init` to generate project documentation for the AI
3. **Install relevant skills**: `/setup 4` or `/skills search`
4. **Configure MCP servers**: `/mcp connect` for external tool integration
5. **Start coding**: Just start a conversation — the AI will use tools and skills automatically
