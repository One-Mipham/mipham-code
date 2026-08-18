# web-access CDP 全套照搬 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 `web-access` skill（v2.0.0 路由桩）升级为完整 CDP 能力——通过 CDP Proxy 直连用户已登录 Chrome，并引入 Mipham Code 首个「带可执行资产」的 skill。

**Architecture:** 资产脚本（4 个 `.mjs` + `cdp-api.md`）原样照搬进 `skills/standard/web-access/`，由扩展后的 `generate-bundled-skills.ts` 编译进 `bundled-skill-assets.ts`（单二进制也能带上）；首次调用时由 `skill-assets.ts` 的 `ensureSkillAssets()` 幂等提取到 `~/.mipham/skills/web-access/`，skill 正文用稳定绝对路径 `~/.mipham/skills/web-access/scripts/...` 调起。

**Tech Stack:** TypeScript (strict) + Bun 运行时 + Vitest 3；脚本为 Node 22+ 原生 WebSocket `.mjs`（Bun 兼容）。

**Spec:** `docs/superpowers/specs/2026-08-18-web-access-design.md`（计划从 spec 论证；执行者两篇都读）

## Global Constraints

- 版本底线：CLI 运行时 Bun 1.2+ / Node.js 22+；测试框架 Vitest 3。
- 跨会话测试铁律：`ensureSkillAssets` 测试**禁止用真实 `~/.mipham`**（并行 rmSync 竞态 flaky），必须用注入的 tmpdir 或 mock homedir。
- skill frontmatter `description` 含冒号必加双引号（self-audit 那个 YAML 冒号静默 skip 坑）。
- 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `docs:`）。
- 禁止自动 `git commit` / `git push`——每任务最后一步列 commit 命令，由执行者/用户确认后执行。
- 新增/修改 skill 后必须重新生成 `bundled-skills.ts` 与 `bundled-skill-assets.ts`（`bun run scripts/generate-bundled-skills.ts`），先 `pnpm format` 再生成（bundle 漂移守卫坑）。

---

### Task 1: 资产源落位 + 打包生成器扩展 + 漂移守卫

**Files:**

- Create: `apps/cli/skills/standard/web-access/scripts/cdp-proxy.mjs`（从 `~/.claude/skills/web-access/scripts/cdp-proxy.mjs` 原样拷贝）
- Create: `apps/cli/skills/standard/web-access/scripts/check-deps.mjs`（同上源目录原样拷贝）
- Create: `apps/cli/skills/standard/web-access/scripts/find-url.mjs`（同上）
- Create: `apps/cli/skills/standard/web-access/scripts/match-site.mjs`（同上）
- Create: `apps/cli/skills/standard/web-access/references/cdp-api.md`（从 `~/.claude/skills/web-access/references/cdp-api.md` 拷贝）
- Create: `apps/cli/skills/standard/web-access/references/site-patterns/.gitkeep`（空文件）
- Modify: `apps/cli/scripts/generate-bundled-skills.ts`
- Create: `apps/cli/src/skills/bundled-skill-assets.ts`（由生成器产出）
- Test: `apps/cli/test/tools/skills.test.ts`（追加漂移守卫测试）

**Interfaces:**

- Consumes: 无（第一个任务）。
- Produces: 磁盘资产目录 `skills/standard/web-access/**`；生成常量 `BUNDLED_SKILL_ASSETS: Record<string, { path: string; content: string }[]>`，键 `'web-access'`；后续 Task 2/3/4 依赖它。

- [ ] **Step 1: 拷贝 4 个脚本 + 参考文件到仓库**

```bash
SRC=~/.claude/skills/web-access
DST=apps/cli/skills/standard/web-access
mkdir -p "$DST/scripts" "$DST/references/site-patterns"
cp "$SRC/scripts/cdp-proxy.mjs"     "$DST/scripts/cdp-proxy.mjs"
cp "$SRC/scripts/check-deps.mjs"    "$DST/scripts/check-deps.mjs"
cp "$SRC/scripts/find-url.mjs"      "$DST/scripts/find-url.mjs"
cp "$SRC/scripts/match-site.mjs"    "$DST/scripts/match-site.mjs"
cp "$SRC/references/cdp-api.md"     "$DST/references/cdp-api.md"
touch "$DST/references/site-patterns/.gitkeep"
```

- [ ] **Step 2: 验证拷贝（文件数 + 行数）**

Run: `find apps/cli/skills/standard/web-access -type f | sort && wc -l apps/cli/skills/standard/web-access/scripts/*.mjs`
Expected: 5 个内容文件 + `.gitkeep`；`cdp-proxy.mjs` 650 行、`check-deps.mjs` 171 行、`find-url.mjs` 214 行、`match-site.mjs` 46 行、`cdp-api.md` 106 行。

- [ ] **Step 3: 扩展生成器**

把 `apps/cli/scripts/generate-bundled-skills.ts` 整体替换为（在原有逻辑基础上新增 `collectAssets` 与第二个输出）：

```ts
#!/usr/bin/env bun
/**
 * Generate src/skills/bundled-skills.ts AND src/skills/bundled-skill-assets.ts —
 * in-memory snapshots embedded into the compiled binary.
 *
 * The standalone binary (`bun build --compile`) has no `skills/` directory on
 * disk, so the SkillsLoader falls back to these snapshots. `bundled-skill-assets.ts`
 * additionally carries the executable assets (scripts/references) of skills that
 * ship them (currently `web-access`), extracted to `~/.mipham/skills/<name>/` at
 * first use. Regenerate whenever skills or their assets are added/removed/changed:
 *
 *   bun run scripts/generate-bundled-skills.ts
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CLI_ROOT = join(import.meta.dir, '..')
const SKILLS_DIR = join(CLI_ROOT, 'skills')
const OUTPUT_FILE = join(CLI_ROOT, 'src', 'skills', 'bundled-skills.ts')
const ASSETS_OUTPUT_FILE = join(CLI_ROOT, 'src', 'skills', 'bundled-skill-assets.ts')
const ASSETS_SKILL = 'web-access'
const ASSETS_DIR = join(SKILLS_DIR, 'standard', ASSETS_SKILL)

interface BundledSkill {
  type: 'standard' | 'mipham'
  raw: string
}

interface BundledSkillAsset {
  path: string
  content: string
}

function collect(dir: string, type: 'standard' | 'mipham', ext: string): BundledSkill[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort()
  return files.map((f) => ({
    type,
    raw: readFileSync(join(dir, f), 'utf-8'),
  }))
}

/** Recursively collect executable assets; path is `/`-joined relative to `dir`. */
function collectAssets(dir: string): BundledSkillAsset[] {
  const out: BundledSkillAsset[] = []
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.gitkeep' || name === '.git') continue
      const full = join(d, name)
      const relPath = rel ? `${rel}/${name}` : name
      if (statSync(full).isDirectory()) walk(full, relPath)
      else out.push({ path: relPath, content: readFileSync(full, 'utf-8') })
    }
  }
  walk(dir, '')
  return out
}

function main(): void {
  const standard = collect(join(SKILLS_DIR, 'standard'), 'standard', '.SKILL.md')
  const mipham = collect(join(SKILLS_DIR, 'mipham'), 'mipham', '.mipham-skill.md')
  const all = [...standard, ...mipham]

  const lines: string[] = [
    '// AUTO-GENERATED by scripts/generate-bundled-skills.ts — DO NOT EDIT.',
    '// Regenerate with: bun run scripts/generate-bundled-skills.ts',
    '// In-memory snapshot of the built-in skills, embedded into the compiled binary.',
    '',
    'export interface BundledSkill {',
    "  type: 'standard' | 'mipham'",
    '  raw: string',
    '}',
    '',
    'export const BUNDLED_SKILLS: ReadonlyArray<BundledSkill> = [',
  ]
  for (const s of all) {
    lines.push(`  { type: '${s.type}', raw: ${JSON.stringify(s.raw)} },`)
  }
  lines.push(']')
  lines.push('')
  writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf-8')

  const assets = collectAssets(ASSETS_DIR)
  const assetLines: string[] = [
    '// AUTO-GENERATED by scripts/generate-bundled-skills.ts — DO NOT EDIT.',
    '// Regenerate with: bun run scripts/generate-bundled-skills.ts',
    '// In-memory snapshot of built-in skills that ship executable assets.',
    '',
    'export interface BundledSkillAsset {',
    '  path: string',
    '  content: string',
    '}',
    '',
    'export const BUNDLED_SKILL_ASSETS: Record<string, BundledSkillAsset[]> = {',
    `  ${JSON.stringify(ASSETS_SKILL)}: [`,
    ...assets.map(
      (a) => `    { path: ${JSON.stringify(a.path)}, content: ${JSON.stringify(a.content)} },`,
    ),
    '  ],',
    '}',
    '',
  ]
  writeFileSync(ASSETS_OUTPUT_FILE, assetLines.join('\n'), 'utf-8')

  console.log(
    `Generated ${OUTPUT_FILE} with ${all.length} skills (${standard.length} standard, ${mipham.length} mipham)`,
  )
  console.log(`Generated ${ASSETS_OUTPUT_FILE} with ${assets.length} assets for "${ASSETS_SKILL}"`)
}

main()
```

- [ ] **Step 4: 运行生成器**

Run: `bun run scripts/generate-bundled-skills.ts`（在 `apps/cli/` 下）
Expected: 打印 `Generated ...bundled-skills.ts with 25 skills` 与 `Generated ...bundled-skill-assets.ts with 5 assets for "web-access"`；两个文件被写出。

- [ ] **Step 5: 写漂移守卫测试（追加到 `apps/cli/test/tools/skills.test.ts`）**

在文件顶部 import 区追加 `BUNDLED_SKILL_ASSETS`（现有 `BUNDLED_SKILLS` 已在）后，在文件末尾追加：

```ts
describe('bundled-skill-assets snapshot freshness', () => {
  it('matches web-access assets on disk (regenerate with `bun run scripts/generate-bundled-skills.ts`)', () => {
    const assetsRoot = join(import.meta.dirname, '..', '..', 'skills', 'standard', 'web-access')
    const expected: Array<{ path: string; content: string }> = []
    const walk = (dir: string, rel: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.gitkeep') continue
        const full = join(dir, entry.name)
        const relPath = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) walk(full, relPath)
        else expected.push({ path: relPath, content: readFileSync(full, 'utf-8') })
      }
    }
    walk(assetsRoot, '')
    expect(BUNDLED_SKILL_ASSETS['web-access']).toEqual(expected)
  })
})
```

对应 import 追加：`import { BUNDLED_SKILL_ASSETS } from '../../src/skills/bundled-skill-assets'`。`readdirSync`/`readFileSync`/`join` 已在文件顶部 import。

- [ ] **Step 6: 跑测试**

Run: `cd apps/cli && pnpm test test/tools/skills.test.ts`
Expected: PASS（含新增的 `bundled-skill-assets snapshot freshness` 与既有 `bundled-skills snapshot freshness`）。

- [ ] **Step 7: Commit**

```bash
git add apps/cli/skills/standard/web-access/ apps/cli/scripts/generate-bundled-skills.ts apps/cli/src/skills/bundled-skill-assets.ts apps/cli/test/tools/skills.test.ts
git commit -m "feat(skills): bundle web-access assets — CDP proxy scripts + generator"
```

---

### Task 2: `skill-assets.ts` 提取模块 + 单元测试

**Files:**

- Create: `apps/cli/src/skills/skill-assets.ts`
- Test: `apps/cli/test/skills/skill-assets.test.ts`

**Interfaces:**

- Consumes: `BUNDLED_SKILL_ASSETS`（Task 1 产出）+ 类型 `BundledSkillAsset`。
- Produces: `ensureSkillAssets(skillName: string, opts?: { baseDir?: string; assets?: Record<string, BundledSkillAsset[]> }): string | null`。返回提取目标根路径（`<baseDir>/<skillName>`），无资产返回 `null`。Task 4 的 `skill.ts` 依赖它。

- [ ] **Step 1: 写失败测试**

创建 `apps/cli/test/skills/skill-assets.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureSkillAssets } from '../../src/skills/skill-assets'
import type { BundledSkillAsset } from '../../src/skills/bundled-skill-assets'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skill-assets-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const fakeAssets: Record<string, BundledSkillAsset[]> = {
  'web-access': [
    { path: 'scripts/cdp-proxy.mjs', content: '#!/usr/bin/env node\nconsole.log("proxy")' },
    { path: 'references/cdp-api.md', content: '# CDP API' },
  ],
}

describe('ensureSkillAssets', () => {
  it('returns null for a skill with no bundled assets', () => {
    expect(ensureSkillAssets('unknown', { baseDir: tmp, assets: fakeAssets })).toBeNull()
  })

  it('extracts assets on first call (mkdir recursive)', () => {
    const root = ensureSkillAssets('web-access', { baseDir: tmp, assets: fakeAssets })
    expect(root).toBe(join(tmp, 'web-access'))
    expect(readFileSync(join(root!, 'scripts', 'cdp-proxy.mjs'), 'utf-8')).toBe(
      fakeAssets['web-access'][0].content,
    )
    expect(readFileSync(join(root!, 'references', 'cdp-api.md'), 'utf-8')).toBe(
      fakeAssets['web-access'][1].content,
    )
  })

  it('restores drifted content on next call (content compare)', () => {
    const root = ensureSkillAssets('web-access', { baseDir: tmp, assets: fakeAssets })!
    const dest = join(root, 'scripts', 'cdp-proxy.mjs')
    const original = readFileSync(dest, 'utf-8')
    writeFileSync(dest, 'CORRUPTED')
    ensureSkillAssets('web-access', { baseDir: tmp, assets: fakeAssets })
    expect(readFileSync(dest, 'utf-8')).toBe(original)
    expect(existsSync(join(root, 'references', 'cdp-api.md'))).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/skills/skill-assets.test.ts`
Expected: FAIL（`Cannot find module '../../src/skills/skill-assets'`）。

- [ ] **Step 3: 实现 `skill-assets.ts`**

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { BUNDLED_SKILL_ASSETS, type BundledSkillAsset } from './bundled-skill-assets'

export interface SkillAssetsOptions {
  /** Base dir under which assets land as `<baseDir>/<skillName>/...`. Defaults to `~/.mipham/skills`. */
  baseDir?: string
  /** Asset map. Defaults to the compiled-in snapshot. Injectable for tests. */
  assets?: Record<string, BundledSkillAsset[]>
}

/**
 * Idempotently extract a skill's bundled executable assets to disk.
 * Content-compare: only writes when a file is missing or its content drifted,
 * so user-added files (e.g. site-patterns/*.md) are never overwritten.
 * Returns the extraction root, or null if the skill bundles no assets.
 */
export function ensureSkillAssets(skillName: string, opts?: SkillAssetsOptions): string | null {
  const map = opts?.assets ?? BUNDLED_SKILL_ASSETS
  const base = opts?.baseDir ?? join(homedir(), '.mipham', 'skills')
  const list = map[skillName]
  if (!list) return null
  const root = join(base, skillName)
  for (const a of list) {
    const dest = join(root, a.path)
    const fresh = !existsSync(dest) || readFileSync(dest, 'utf-8') !== a.content
    if (fresh) {
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, a.content)
    }
  }
  return root
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/skills/skill-assets.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/skills/skill-assets.ts apps/cli/test/skills/skill-assets.test.ts
git commit -m "feat(skills): add ensureSkillAssets — idempotent extraction to ~/.mipham/skills"
```

---

### Task 3: 升级 `web-access.SKILL.md`（合并 v2.5.0 CDP）+ loader 测试

**Files:**

- Modify: `apps/cli/skills/standard/web-access.SKILL.md`
- Modify: `apps/cli/src/skills/bundled-skills.ts`（重新生成，因为 skill 正文变了）
- Test: `apps/cli/test/tools/skills.test.ts`（追加 web-access 升级断言）

**Interfaces:**

- Consumes: 无（纯 markdown 改写）。
- Produces: skill `web-access` version `2.5.0`，正文含 CDP 段 + 绝对路径 `~/.mipham/skills/web-access`。Task 4 的触发钩子按名命中它。

- [ ] **Step 1: 写升级后的 skill 正文**

重写 `apps/cli/skills/standard/web-access.SKILL.md`，frontmatter + 正文结构如下（正文内容来源：`~/.claude/skills/web-access/SKILL.md` 的 CDP 全文 + 现有 v2.0.0 的路由树/Security Rules，按 spec §4.1 合并）：

````markdown
---
name: web-access
description: '联网访问：CDP 驱动用户已登录 Chrome（登录后操作、动态页面、反爬站点、社交媒体、本地书签/历史检索）'
license: MIT
github: https://github.com/eze-is/web-access
version: 2.5.0
user-invocable: true
allowed-tools:
  - Bash
  - WebFetch
  - WebSearch
  - ComputerUse
  - Read
---

# Web Access — CDP 驱动已登录 Chrome

> 来源：eze-is/web-access (MIT)，Mipham Code 合并升级。核心能力 = CDP Proxy 直连用户日常 Chrome，天然携带登录态。

## 前置检查

先确保 CDP 就绪：

```bash
node ~/.mipham/skills/web-access/scripts/check-deps.mjs
```
````

> Mipham Code 环境：`node` 不可用时可用 `bun` 替代（Bun 原生支持 WebSocket 与 node: 内建）。未通过时引导用户：Chrome 地址栏打开 `chrome://inspect/#remote-debugging`，勾选 "Allow remote debugging for this browser instance"。

**必须向用户展示**：部分站点对浏览器自动化检测严格，存在账号封禁风险。已内置防护但无法完全避免，Agent 继续操作即视为接受。

## 工具选择

| 场景                                          | 工具        |
| --------------------------------------------- | ----------- |
| 搜索摘要 / 发现来源                           | WebSearch   |
| URL 已知，定向提取                            | WebFetch    |
| URL 已知，要原始 HTML（meta/JSON-LD）         | Bash + curl |
| 非公开内容 / 反爬站点（小红书、微信公众号等） | 浏览器 CDP  |
| 需要登录态、交互、自由导航                    | 浏览器 CDP  |

浏览器 CDP 不要求 URL 已知；WebSearch/WebFetch/curl 均不处理登录态。

## 浏览器 CDP 模式

通过 CDP Proxy 直连用户日常 Chrome，天然携带登录态。**不主动操作用户已有 tab**，所有操作在自己创建的后台 tab 中进行，任务结束关闭自建 tab（保留用户原 tab）。

Proxy API（curl 调 `http://localhost:3456/...`）：

| 端点                                       | 用途                                |
| ------------------------------------------ | ----------------------------------- |
| `GET /targets`                             | 列出已开 tab                        |
| `GET /new?url=`                            | 新建后台 tab（自动等加载）          |
| `GET /navigate?target=&url=`               | 导航（自动等加载）                  |
| `GET /back?target=`                        | 后退                                |
| `GET /info?target=`                        | 页面标题/URL/状态                   |
| `POST /eval?target=`（body=JS）            | 执行任意 JS（读写 DOM、提取、提交） |
| `POST /click?target=`（body=CSS 选择器）   | JS 点击                             |
| `POST /clickAt?target=`（body=CSS 选择器） | 真实鼠标点击（算用户手势）          |
| `POST /setFiles?target=`（body JSON）      | 设置 file input 本地文件路径        |
| `GET /scroll?target=&y=&direction=`        | 滚动（触发懒加载）                  |
| `GET /screenshot?target=&file=`            | 截图                                |
| `GET /close?target=`                       | 关闭 tab                            |

进入浏览器层后，`/eval` 是眼睛、`/click` 是手：先看 DOM 结构再决定下一步，不预先规划所有步骤。

### 登录判断

核心问题只有一个：**目标内容拿到了吗？** 打开页面先尝试获取目标内容；确认「目标内容无法获取」且判断登录能解决时，告知用户在其 Chrome 登录后继续（无需重启任何东西，刷新页面即可）。

### 媒体资源提取

判断内容在图片里时，用 `/eval` 从 DOM 直接拿图片 URL 定向读取，比全页截图精准。`/scroll` 到底部触发懒加载后再提取图片 URL。

### 视频内容获取

用户 Chrome 真实渲染，截图可捕获当前视频帧。用 `/eval` 操控 `<video>`（时长、seek、播放/暂停），配合 `/screenshot` 采帧，做离散采样分析。

## 本地 Chrome 资源

用户指向「本人访问过的页面」或「组织内部系统」时，检索本地书签/历史：

```bash
node ~/.mipham/skills/web-access/scripts/find-url.mjs [关键词...] [--only bookmarks|history] [--limit N] [--since 1d|7h|YYYY-MM-DD] [--sort recent|visits]
```

## 并行调研：子 Agent 分治

多个独立调研目标时，分治给子 Agent 并行执行（共享一个 Chrome、一个 Proxy，各自建 tab、各自 `/close`，无竞态）。子 Agent prompt 写**目标**（「获取/调研/了解」），不写**手段**（避免「搜索xx」锚定到 WebSearch 而错过需 CDP 的反爬站点）。

## 信息核实

核实目标是一手来源，非二手报道。搜索引擎是**定位**工具，不可直接**证明**真伪；找到来源后直接访问读原文。

| 信息类型      | 一手来源       |
| ------------- | -------------- |
| 政策/法规     | 发布机构官网   |
| 企业公告      | 公司官方新闻页 |
| 工具能力/用法 | 官方文档、源码 |

## 站点经验

特定网站经验按域名存 `~/.mipham/skills/web-access/references/site-patterns/<domain>.md`（frontmatter: domain/aliases/updated + 平台特征/有效模式/已知陷阱）。操作前若有匹配经验先读；操作成功后把验证过的新模式写回。

## Security Rules

- 不主动操作用户已有 tab；任务结束关闭自建 tab。
- 不提交凭据（除非用户显式批准）。
- 尊重 robots.txt 与速率限制；不抓 PII。
- proxy 仅绑 127.0.0.1，不暴露外网。
- 所有 URL 过 SSRF 校验后才 fetch。

## 何时不用本 skill

- 纯逻辑/算法题（推理非研究）。
- 代码已在上下文里的问题。
- 大文件下载 → Bash + curl。

````

> 说明：上表「浏览器 CDP 模式」的端点需与 `~/.claude/skills/web-access/SKILL.md`「Proxy API」节逐一核对，补全 `/clickAt` 触发文件对话框、`/setFiles` 绕过对话框、`/scroll` 懒加载等细节措辞（以源文件为准，不臆造参数）。

- [ ] **Step 2: 重新生成 bundled-skills**

Run: `cd apps/cli && pnpm format && bun run scripts/generate-bundled-skills.ts`
Expected: `bundled-skills.ts` 中 `web-access` 条目的 `raw` 更新为新的 2.5.0 正文。

- [ ] **Step 3: 追加 loader 升级断言（`apps/cli/test/tools/skills.test.ts`）**

在「Built-in skills」describe 内追加：

```ts
it('web-access skill is upgraded to CDP v2.5.0', () => {
  const loader = new SkillsLoader()
  const projectRoot = join(import.meta.dirname, '..', '..')
  loader.loadBuiltin(projectRoot)

  const skill = loader.get('web-access')
  expect(skill?.version).toBe('2.5.0')
  expect(skill?.body).toContain('cdp-proxy')
  expect(skill?.body).toContain('~/.mipham/skills/web-access')
  expect(skill?.body).toContain('localhost:3456')
})
````

- [ ] **Step 4: 跑测试**

Run: `cd apps/cli && pnpm test test/tools/skills.test.ts`
Expected: PASS（既有 25-skill 计数 / 名字列表不变，新增 web-access 升级断言通过）。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/skills/standard/web-access.SKILL.md apps/cli/src/skills/bundled-skills.ts apps/cli/test/tools/skills.test.ts
git commit -m "feat(skills): upgrade web-access to CDP v2.5.0 — merge eze-is/web-access proxy guidance"
```

---

### Task 4: `skill.ts` 触发钩子 + 集成测试

**Files:**

- Modify: `apps/cli/src/tools/agent/skill.ts`
- Test: `apps/cli/test/tools/skill-tool-assets.test.ts`（新建）

**Interfaces:**

- Consumes: `ensureSkillAssets`（Task 2 产出）。
- Produces: `Skill` 工具在 invoke 任一有资产的 skill 时先提取资产。无新导出符号（仅内部副作用）。

- [ ] **Step 1: 写失败集成测试**

创建 `apps/cli/test/tools/skill-tool-assets.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { SkillsLoader } from '../../src/skills/loader'

vi.mock('../../src/skills/skill-assets', () => ({ ensureSkillAssets: vi.fn() }))
import { ensureSkillAssets } from '../../src/skills/skill-assets'
import { skillTool } from '../../src/tools/agent/skill'

describe('Skill tool — asset extraction trigger', () => {
  it('calls ensureSkillAssets when invoking a skill that bundles assets', async () => {
    const loader = new SkillsLoader()
    loader.loadBuiltinFromPackage()

    const ctx = { skillsLoader: loader } as never
    const result = await skillTool.execute(
      { skill: 'web-access' },
      ctx as Parameters<typeof skillTool.execute>[1],
    )

    expect(result.success).toBe(true)
    expect(ensureSkillAssets).toHaveBeenCalledWith('web-access')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test test/tools/skill-tool-assets.test.ts`
Expected: FAIL（`ensureSkillAssets` 未被调用 → `toHaveBeenCalledWith('web-access')` 失败）。

- [ ] **Step 3: 加触发钩子**

在 `apps/cli/src/tools/agent/skill.ts` 顶部 import 区加：

```ts
import { ensureSkillAssets } from '../../skills/skill-assets'
```

在 `execute()` 里，`loader.get(skillName)` 命中、`if (!skill) { ... }` 错误块之后，加一行：

```ts
// Extract executable assets (scripts/references) if this skill bundles them.
// No-op for every skill that has no entry in BUNDLED_SKILL_ASSETS.
ensureSkillAssets(skillName)
```

（落在 `if (skill.context === 'fork')` 判断之前，这样 fork 与 inline 两条路径都先提取。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test test/tools/skill-tool-assets.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/tools/agent/skill.ts apps/cli/test/tools/skill-tool-assets.test.ts
git commit -m "feat(skills): trigger asset extraction on skill invocation"
```

---

### Task 5: CLAUDE.md 文档更新

**Files:**

- Modify: `CLAUDE.md`（mipham-code 仓库根）

**Interfaces:**

- Consumes: 无。
- Produces: 文档一致性（skills 25 仍是 25 —— web-access 本就计入 standard 20，无需改计数；更新 Skills 系统一节描述 + 修订历史）。

- [ ] **Step 1: 更新「Skills 系统」一节的 standard 描述**

在 `CLAUDE.md` 的 `### Skills 系统（25 个内置技能）` 下，把 `**Standard（20）**:` 那段列表后的说明（如有）更新，或在列表后补一行 web-access 说明：

```markdown
**Standard（20）**: code-review, codebase-design, compassionate-communication, debug-loop, doc-generator, domain-modeling, github-ops, grill-with-docs, implement, memory, mipham-code-setup, research, security-review, self-review, superpower, tdd, to-spec, triage, web-access, web-search

> `web-access`（v2.5.0）是首个**带可执行资产**的 standard skill：CDP Proxy 直连用户已登录 Chrome（脚本随二进制内嵌，首次调用提取到 `~/.mipham/skills/web-access/`）。
```

- [ ] **Step 2: 追加修订历史一条**

在 `CLAUDE.md` 的修订历史表顶部加：

```markdown
| 2.3.9 | 2026-08-18 | web-access 升级 v2.5.0：CDP Proxy 直连用户已登录 Chrome（4 脚本 + cdp-api.md 原样照搬 eze-is/web-access）；新增「技能资产」机制（bundled-skill-assets.ts + ensureSkillAssets 提取到 ~/.mipham/skills/）；standard 轨首个带可执行资产的 skill | 技术委员会 |
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): 2.3.9 — web-access CDP 升级 + 技能资产机制"
```

---

## Self-Review（计划已自审）

- **Spec 覆盖**：§4.1（skill 升级）→ Task 3；§4.2（资产打包）→ Task 1；§4.3（提取）→ Task 2；§4.4（触发钩子）→ Task 4；§八（文档）→ Task 5；§七（测试）→ Task 1/2/3/4 各自测试。无缺口。
- **占位扫描**：无 TBD/TODO；每步有真实代码或命令；「升级正文」虽引用源文件，但给出完整可落地的 frontmatter + 分节结构 + 端点表 + 合并策略，非占位。
- **类型一致性**：`BundledSkillAsset { path; content }` 在生成器（Task 1）、`skill-assets.ts`（Task 2）、测试（Task 1/2）三处一致；`ensureSkillAssets(skillName, opts?)` 签名在 Task 2 定义、Task 4 调用一致；`BUNDLED_SKILL_ASSETS['web-access']` 键名在 Task 1 生成、Task 2 消费、Task 1 测试断言一致。

> 注意：Task 3 的「升级正文」是合并两处既有源文件，正文完整措辞以 `~/.claude/skills/web-access/SKILL.md` 为准、端点参数不臆造——执行者需同时打开源文件与现有 `web-access.SKILL.md` 核对。
