/**
 * Mipham Code — LoopKit Scaffold
 *
 * Creates a LoopKit Vault project structure under .mipham/.
 * Mirrors the Claude Code .claude/ convention adapted for Mipham Code.
 *
 * Reference: LoopKit Vault structure
 *   .claude/CLAUDE.md, settings.json, hooks/, agents/, skills/<9 domains>/
 *   .mcp.json, MEMORY.md, run.sh, install.sh, README.md
 */

import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface ScaffoldResult {
  created: string[]
  skipped: string[]
}

/** 9 skill domain directories matching the LoopKit Vault convention */
const SKILL_DOMAINS = [
  'agents-llm',
  'debug',
  'security',
  'frontend',
  'testing',
  'refactor',
  'docs',
  'data',
  'git-ops',
]

function ensureDir(dir: string, created: string[], _skipped: string[]): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    created.push(dir)
  }
}

function writeTemplate(
  path: string,
  content: string,
  executable: boolean,
  created: string[],
  skipped: string[],
): void {
  if (existsSync(path)) {
    skipped.push(path)
    return
  }
  writeFileSync(path, content, 'utf-8')
  if (executable) {
    chmodSync(path, 0o755)
  }
  created.push(path)
}

/**
 * Create the LoopKit Vault project structure at the given base path.
 *
 * Directory tree created:
 * ```
 * <basePath>/
 * ├── .mipham/
 * │   ├── CLAUDE.md
 * │   ├── settings.json
 * │   ├── hooks/
 * │   │   ├── pre-tool-use.sh
 * │   │   ├── post-tool-use.sh
 * │   │   └── stop.sh
 * │   ├── agents/
 * │   │   └── verifier.md
 * │   └── skills/
 * │       ├── agents-llm/
 * │       ├── debug/
 * │       ├── security/
 * │       ├── frontend/
 * │       ├── testing/
 * │       ├── refactor/
 * │       ├── docs/
 * │       ├── data/
 * │       └── git-ops/
 * ├── .mcp.json
 * ├── MEMORY.md
 * ├── README.md
 * ├── run.sh
 * └── install.sh
 * ```
 */
export function scaffoldLoopKit(basePath: string): ScaffoldResult {
  const created: string[] = []
  const skipped: string[] = []

  const resolved = resolve(basePath.replace(/^~/, process.env.HOME || '~'))
  const miphamDir = join(resolved, '.mipham')

  // ── .mipham/ root ──
  ensureDir(miphamDir, created, skipped)

  // ── .mipham/CLAUDE.md ──
  writeTemplate(join(miphamDir, 'CLAUDE.md'), TEMPLATES.claudeMd, false, created, skipped)

  // ── .mipham/settings.json ──
  writeTemplate(join(miphamDir, 'settings.json'), TEMPLATES.settingsJson, false, created, skipped)

  // ── .mipham/hooks/ ──
  const hooksDir = join(miphamDir, 'hooks')
  ensureDir(hooksDir, created, skipped)
  writeTemplate(join(hooksDir, 'pre-tool-use.sh'), TEMPLATES.preToolUse, true, created, skipped)
  writeTemplate(join(hooksDir, 'post-tool-use.sh'), TEMPLATES.postToolUse, true, created, skipped)
  writeTemplate(join(hooksDir, 'stop.sh'), TEMPLATES.stopHook, true, created, skipped)

  // ── .mipham/agents/ ──
  const agentsDir = join(miphamDir, 'agents')
  ensureDir(agentsDir, created, skipped)
  writeTemplate(join(agentsDir, 'verifier.md'), TEMPLATES.verifierAgent, false, created, skipped)

  // ── .mipham/skills/<9 domains>/ ──
  const skillsDir = join(miphamDir, 'skills')
  ensureDir(skillsDir, created, skipped)
  for (const domain of SKILL_DOMAINS) {
    const domainDir = join(skillsDir, domain)
    ensureDir(domainDir, created, skipped)
    // Add .gitkeep so git tracks empty directories
    writeTemplate(join(domainDir, '.gitkeep'), '', false, created, skipped)
  }

  // ── Root-level files ──

  // .mcp.json
  writeTemplate(join(resolved, '.mcp.json'), TEMPLATES.mcpJson, false, created, skipped)

  // MEMORY.md
  writeTemplate(join(resolved, 'MEMORY.md'), TEMPLATES.memoryMd, false, created, skipped)

  // README.md
  writeTemplate(join(resolved, 'README.md'), TEMPLATES.readmeMd, false, created, skipped)

  // run.sh
  writeTemplate(join(resolved, 'run.sh'), TEMPLATES.runSh, true, created, skipped)

  // install.sh
  writeTemplate(join(resolved, 'install.sh'), TEMPLATES.installSh, true, created, skipped)

  return { created, skipped }
}

// ═══════════════════════════════════════════════════════════════
// Templates
// ═══════════════════════════════════════════════════════════════

const TEMPLATES = {
  claudeMd: `# CLAUDE.md

> Mipham Code project instructions — defines how the AI assistant behaves in this project.
> Edit this file to customize: coding conventions, project structure, AI preferences.

## Project Overview

[Describe your project — what it does, who it's for, key technologies]

## Coding Conventions

- [Add your team's coding rules, style preferences, naming conventions]
- [Example: Use TypeScript strict mode, ESM modules, pnpm package manager]

## AI Interaction Preferences

- Response language: [English / 中文]
- Comment language: [English / 中文]
- Code style: [functional / OOP / mixed]
- Testing: [always write tests / only for critical paths]
`,

  settingsJson:
    JSON.stringify(
      {
        permissions: {
          allow: [],
          deny: [],
        },
        hooks: {
          PreToolUse: [],
          PostToolUse: [],
          Stop: [],
          SessionStart: [],
          UserPromptSubmit: [],
          Notification: [],
        },
      },
      null,
      2,
    ) + '\n',

  preToolUse: `#!/bin/bash
# PreToolUse hook — runs before each tool execution.
# Tool name passed as \$1, input JSON as \$2.
# Exit non-zero to block the tool.
# Write JSON to stdout to modify the tool input.

TOOL_NAME="\$1"
TOOL_INPUT="\$2"

echo "{\\"decision\\": \\"allow\\"}" >&2
exit 0
`,

  postToolUse: `#!/bin/bash
# PostToolUse hook — runs after each tool execution.
# Tool name passed as \$1, result JSON as \$2.

TOOL_NAME="\$1"
TOOL_RESULT="\$2"

exit 0
`,

  stopHook: `#!/bin/bash
# Stop hook — runs when the AI session ends.
# Use for cleanup, notifications, or saving state.

echo "Session ended at \$(date)" >&2
exit 0
`,

  verifierAgent: `# Verifier Agent

> Pre-commit audit specialist. Dispatched BEFORE committing to verify changes.

## Role

Verify staged changes against coding standards, security rules, and best practices.

## When to Use

- Before committing code changes
- Quality gate in CI/CD pipelines
- Post-implementation review

## Instructions

1. Read the staged diff
2. Check for: security issues, code quality violations, test coverage gaps
3. Report findings with file:line citations
4. Return verdict: pass, needs-fix, or block
`,

  mcpJson:
    JSON.stringify(
      {
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          },
        },
      },
      null,
      2,
    ) + '\n',

  memoryMd: `# MEMORY.md

> Persistent project memory — survives across AI sessions.
> Add important facts, decisions, and context here.

## Key Decisions

- [Date]: [Decision made and why]

## Project Context

- [Important context for AI to remember across sessions]

## Resources

- [Links, references, external documentation]
`,

  readmeMd: `# [Project Name]

> Generated by Mipham Code /loop init scaffold.

## Quick Start

\`\`\`bash
./install.sh   # Install dependencies
./run.sh       # Start the project
\`\`\`

## Structure

- \`.mipham/\` — Mipham Code configuration (CLAUDE.md, settings, hooks, agents, skills)
- \`.mcp.json\` — MCP server configuration
- \`MEMORY.md\` — AI persistent memory
- \`run.sh\` — Project launcher
- \`install.sh\` — Dependency installer

## Learn More

- Mipham Code: https://mipham.ai/code
- MCP Protocol: https://modelcontextprotocol.io
`,

  runSh: `#!/bin/bash
# Mipham Code — project launcher
# Generated by /loop init

set -e

echo "Starting project..."
echo "Run 'mipham' to launch the AI coding assistant."

# Uncomment to auto-start Mipham Code:
# mipham
`,

  installSh: `#!/bin/bash
# Mipham Code — dependency installer
# Generated by /loop init

set -e

echo "Installing project dependencies..."

# Check for Bun
if command -v bun &> /dev/null; then
  echo "✓ Bun found: \$(bun --version)"
else
  echo "⚠ Bun not found. Install from https://bun.sh"
fi

# Check for Mipham Code
if command -v mipham &> /dev/null; then
  echo "✓ Mipham Code found: \$(mipham --version 2>&1 | head -1)"
else
  echo "⚠ Mipham Code not found. Install: npm install -g @miphamai/cli"
fi

echo "Done. Run ./run.sh to start."
`,
}
