# Mipham Code web-access skill 全套照搬

> **版本**: 1.0.0
> **日期**: 2026-08-18
> **状态**: 设计完成，待实现
> **参考**: [eze-is/web-access](https://github.com/eze-is/web-access)（MIT）—— CDP 驱动用户日常已登录 Chrome 的 skill
> **路线图**: 实现计划见 `docs/superpowers/plans/2026-08-18-web-access.md`（writing-plans 阶段产出）

---

## 一、目标

Mipham Code 现有网络能力有三条（`web-fetch` / `web-search` / `computer-use`），但都**不带登录态**：

- `web-fetch` / `web-search` 是静态层，过不了登录墙、反爬站点。
- `computer-use` 的 `browser_*` 用 Playwright `chromium.launch({ headless: false })` 拉**全新浏览器**，无 cookie、无登录态。

本设计把现有 **web-access skill（v2.0.0 路由桩）升级为完整 CDP 能力**：通过 CDP Proxy 直连用户日常 Chrome，天然携带登录态，能开已有 tab、操作登录后页面、抓取反爬站点（小红书/微信公众号等）。

> **现状（2026-08-18 核实）**：`apps/cli/skills/standard/web-access.SKILL.md` 已存在（v2.0.0，6KB），但它只是**路由桩**——把请求路由到 WebSearch/WebFetch/ComputerUse，login-required 一律走 ComputerUse 的**全新浏览器**（无登录态）。本设计**合并升级**：保留路由决策树，新增 CDP 模式，`login-required → CDP（已登录 Chrome）` 取代 `login-required → ComputerUse 全新浏览器`。这是首个**带可执行资产**的 skill。

**非目标（范围外）**：

- 不做 CDP proxy 的 TS 重写（照搬原样 `.mjs`）。
- 不做 `computer-use` 的 `connectOverCDP` 升级（保持现有 `computer-use` 不动）。
- 不做桌面 App、不并入 daemon。
- 不翻译 skill 正文（保留中文原文，与现有 mipham/standard 内建 skill 一致）。

---

## 二、设计决策

| 维度       | 选择                                                                    | 理由                                                                                             |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 形态       | **B — 照搬 web-access skill 全套**（skill + 4 脚本 + 参考）             | 用户选定；最有价值，登录态 + 反爬 + 站点经验一次到位                                             |
| 轨道       | **standard**（`.SKILL.md`）                                             | web-access 是 MIT 社区 skill（eze-is），非 MiphamAI 专有；归标准轨更诚实                         |
| 脚本发布   | **A — 原样照搬 `.mjs` + 首次使用提取到 `~/.mipham/skills/web-access/`** | 忠实照搬、零重写风险；MIT 已有反爬 port guard / 托管 tab / 反自动化硬化                          |
| 脚本运行时 | `node`（Node 22+ 原生 WebSocket），`bun` 兼容                           | Mipham Code CLI 本就要求 Bun 或 Node 22+；两套运行时都支持 `node:` 内建 + `globalThis.WebSocket` |
| 提取时机   | **懒触发**，钩在 `Skill` 工具 `execute()`                               | 只在用户真用 web-access 时碰 `~/.mipham`，避免启动写盘副作用；通用（按资产 map 判空，不硬编码）  |
| 幂等       | **内容比对**（逐文件 read+compare，不一致才重写）                       | 自愈（用户误删/二进制升级资产后自动补写）；站点经验目录用户自建文件永不被覆盖                    |
| 安全门控   | 复用 `bash` 工具 6 级权限 + proxy 仅绑 127.0.0.1 + 账号风险提示         | 实际操作走 curl localhost，天然过权限层；proxy 不暴露外网                                        |

---

## 三、文件拓扑

```
apps/cli/skills/standard/web-access.SKILL.md               ← 升级的 skill 正文（v2.0.0 路由桩 + v2.5.0 CDP 全文合并；唯一被 loader 扫描的文件）
apps/cli/skills/standard/web-access/
├── scripts/
│   ├── cdp-proxy.mjs          (650 行，CDP proxy 常驻进程)
│   ├── check-deps.mjs         (171 行，环境检查 + 自动拉起 proxy)
│   ├── find-url.mjs           (214 行，搜本地 Chrome 书签/历史)
│   └── match-site.mjs         (46 行，站点经验匹配)
└── references/
    ├── cdp-api.md             (106 行，CDP API 参考)
    └── site-patterns/.gitkeep (空目录，站点经验落点)
```

运行时（首次调用 web-access 后）：

```
~/.mipham/skills/web-access/
├── scripts/{cdp-proxy,check-deps,find-url,match-site}.mjs
└── references/{cdp-api.md, site-patterns/}
```

---

## 四、组件设计

### 4.1 Skill 本体

**升级** `apps/cli/skills/standard/web-access.SKILL.md`（v2.0.0 路由桩 → v2.5.0），frontmatter：

```yaml
---
name: web-access
description: '联网访问：CDP 驱动用户已登录 Chrome（登录后操作、动态页面、反爬站点、社交媒体、本地书签/历史检索）'
license: MIT
github: https://github.com/eze-is/web-access
version: 2.5.0
user-invocable: true
allowed-tools: [Bash, WebFetch, WebSearch, ComputerUse, Read]
---
```

- `description` 用**双引号包裹**（避开 self-audit 那个 YAML 冒号静默 skip 坑）；写成一句精炼触发语（进 system-reminder 用，loader 会再截断到 200 字符）。
- `license` / `github` 是保留归属字段，loader 不读取、无害。
- 正文**合并**，策略：
  1. **保留** v2.0.0 的路由决策树（WebSearch/WebFetch 静态层）与 Security Rules / Verification / Attribution 节。
  2. **替换** `login-required → ComputerUse 全新浏览器` 分支为 `→ CDP proxy（已登录 Chrome）`。
  3. **并入** v2.5.0 全文的 CDP 能力：浏览哲学 / 工具选择表（含 curl / Jina）/ CDP 模式 proxy API 表 / 登录判断 / 视频采样 / 并行分治 / 信息核实 / 站点经验。
  4. 路径替换：`${CLAUDE_SKILL_DIR}` → `~/.mipham/skills/web-access`。
  5. 在「前置检查」节补一行：`Mipham Code 环境：node 不可用时可用 bun 替代（Bun 原生支持 WebSocket 与 node: 内建）。`

**sanitizer 兼容性已核**：正文无 `!` 行首、无 `@file.ext`、markdown 围栏成对 → `sanitizeSkillBody` 不改动正文、无致命告警。

### 4.2 资产打包（新）

扩展 `apps/cli/scripts/generate-bundled-skills.ts`，在收集 skill `.md` 之外，新增递归收集 `skills/standard/web-access/` 目录（排除 `.gitkeep`），emit 新生成文件：

```ts
// src/skills/bundled-skill-assets.ts（AUTO-GENERATED）
export interface BundledSkillAsset {
  path: string
  content: string
}
export const BUNDLED_SKILL_ASSETS: Record<string, BundledSkillAsset[]> = {
  'web-access': [
    { path: 'scripts/cdp-proxy.mjs', content: '...' },
    { path: 'scripts/check-deps.mjs', content: '...' },
    { path: 'scripts/find-url.mjs', content: '...' },
    { path: 'scripts/match-site.mjs', content: '...' },
    { path: 'references/cdp-api.md', content: '...' },
  ],
}
```

- `path` 相对 web-access 资产根；`content` 为文件原文（`JSON.stringify`）。
- 编译进单二进制，弥补 `bun build --compile` 运行时无 `skills/` 目录的缺口。
- 漂移守卫测试：`BUNDLED_SKILL_ASSETS` 与磁盘 `skills/standard/web-access/` 一致，否则 CI 红（同 bundled-skills 单一真源守卫）。

### 4.3 资产提取（新）

新模块 `apps/cli/src/skills/skill-assets.ts`：

```ts
const SKILL_ASSETS_DIR = join(homedir(), '.mipham', 'skills')

/** 幂等提取某 skill 的捆绑资产到 ~/.mipham/skills/<name>/；无资产返回 null。 */
export function ensureSkillAssets(skillName: string): string | null {
  const assets = BUNDLED_SKILL_ASSETS[skillName]
  if (!assets) return null
  const root = join(SKILL_ASSETS_DIR, skillName)
  for (const a of assets) {
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

- 内容比对幂等：仅首次或内容漂移时写盘；用户后加的 `site-patterns/*.md` 不在捆绑清单里，永不被覆盖。
- 沿用 `~/.mipham` 既有运行时目录惯例（memory / sis / crsi 同款）。

### 4.4 触发钩子

`apps/cli/src/tools/agent/skill.ts` 的 `execute()`，在 `loader.get(skillName)` 命中后、返回正文前加一行：

```ts
ensureSkillAssets(skillName) // no-op 除非该 skill 有捆绑资产
```

- 对所有现有 skill 是空操作（它们都不在 `BUNDLED_SKILL_ASSETS` map 里）。
- 不硬编码 `web-access`；未来新增带资产的 skill 自动生效。

---

## 五、数据流

```
用户：「打开我已登录的 XX 后台看看」
   │
   ▼
system-reminder 命中 → Agent 调 Skill 工具(name=web-access)
   │
   ├─ loader.get('web-access') 命中
   ├─ ensureSkillAssets('web-access')  → 写 ~/.mipham/skills/web-access/**（幂等）
   └─ 返回 skill 正文给 Agent
        │
        ▼
Agent 按正文前置检查：
   node ~/.mipham/skills/web-access/scripts/check-deps.mjs
        │  → check-deps 自动探测 Chrome 调试端口 → 拉起 cdp-proxy（detached，127.0.0.1:3456）
        ▼
Agent 用 bash 工具 curl localhost:3456/{targets,new,eval,click,screenshot,...}
        │  → 每次 curl 过 Mipham Code 权限层（6 级）
        ▼
任务结束 → /close 关自建 tab（保留用户原 tab）；proxy 常驻不主动停
```

---

## 六、错误处理

| 场景                       | 行为                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| Chrome 未开远程调试端口    | `check-deps.mjs` 引导用户到 `chrome://inspect/#remote-debugging` 勾选    |
| 脚本不存在（提取未触发）   | 由 `ensureSkillAssets` 在 Skill 工具命中时保证；仍失败则正文首行提示重跑 |
| proxy 端口被占但非本 proxy | `cdp-proxy.mjs` 探测 `/health` 后报错退出                                |
| 未安装 node 且无 bun       | `check-deps.mjs` 输出版本警告；正文补 `bun` 替代指引                     |
| 资产内容漂移               | 下次调用自动重写；漂移守卫测试在 CI 兜底                                 |

---

## 七、测试

| 测试                   | 覆盖                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `skill-assets.test.ts` | `ensureSkillAssets` 首写 / 幂等不重写 / 内容漂移重写 / 无资产返回 null / mkdir 递归           |
| 资产漂移守卫           | `BUNDLED_SKILL_ASSETS` 与磁盘 `skills/standard/web-access/` 一致（同 bundled-skills 模式）    |
| `loader` 加载          | web-access skill 能加载：frontmatter 解析、无 command/MCP shadow、正文过 sanitizer 无致命告警 |
| 脚本冒烟（可选/手动）  | `bun scripts/cdp-proxy.mjs` 起后 `/health` 返回 ok（需本地 Chrome，不纳入 CI）                |

> 跨会话测试铁律：`ensureSkillAssets` 测试须 mock `node:os` homedir，禁止用真实 `~/.mipham`（并行 rmSync 竞态 flaky）。

---

## 八、文档与收尾

- CLAUDE.md：skills 25→26；标准轨清单加 `web-access`；「Skills 系统」一节补 web-access 说明；修订历史一条（2.3.9）。
- 与版本 bump（任务 #3）同批发布：`bump-version.sh` + tag + push + 父仓库 gitlink。

---

## 九、规格自审（已过）

- 无 TBD / 占位。
- 各节一致：轨道（standard）、脚本发布（提取 `~/.mipham`）、触发（Skill 工具懒触发）三处相互印证。
- 范围聚焦单 skill + 一个资产机制，可单次实现计划覆盖。
- 无歧义：运行时 `node` 主用 / `bun` 兼容已在正文与决策表双重写明。
