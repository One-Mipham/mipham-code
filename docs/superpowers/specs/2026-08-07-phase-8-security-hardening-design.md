# Mipham Code — Phase 8 安全加固设计 Spec

> **版本**: 1.0.0
> **日期**: 2026-08-07
> **阶段**: Phase 8 — 安全加固（三箭齐发）
> **维护人**: One Mipham Corporation 技术委员会

---

## 一、目标

为 Mipham Code 实施全面安全加固，覆盖三个独立子系统：

1. **依赖审计** — 清空 42 个已知漏洞，CI 门禁阻断未来漏洞，Dependabot 自动更新
2. **渗透测试** — 6 大攻击向量的自动化安全测试套件 + SecurityGate 防御模块
3. **密钥轮换** — API Key 生命周期管理、90 天过期提醒、安全备份

---

## 二、现状基线

| 模块              | 文件                        | 能力                                                         |
| ----------------- | --------------------------- | ------------------------------------------------------------ |
| Path Security     | `security/path.ts`          | 路径沙箱（symlink 解析、/etc/proc/sys 拦截、cwd 强制）       |
| URL Security      | `security/url.ts`           | SSRF 防护（协议白名单、内网 IP、DNS rebinding）              |
| Credential Masker | `core/credential-masker.ts` | 文件读取时凭证脱敏                                           |
| Permission        | `core/permission.ts`        | 6 级权限控制（default/acceptEdits/plan/auto/dontAsk/bypass） |
| Bash Tool         | `tools/exec/bash.ts`        | 命令执行 + 超时控制                                          |

**当前缺口**: 42 npm 漏洞（22 high）、无渗透测试、无密钥轮换机制。

---

## 三、子项 1 — 依赖审计

### 3.1 漏洞清单

| Package         | 当前版本         | 修复版本  | 路径            | 严重度   |
| --------------- | ---------------- | --------- | --------------- | -------- |
| next            | 14.2.35          | >=15.5.21 | apps/web        | 15× high |
| vite            | 8.0.14           | >=8.0.16  | vitest 子依赖   | 1× high  |
| postcss         | 8.4.31           | >=8.5.12  | next 子依赖     | 若干     |
| js-yaml         | 4.2.0            | >=4.3.0   | eslintrc 子依赖 | 间接     |
| brace-expansion | <1.1.16 / <5.0.7 | latest    | eslint 子依赖   | 间接     |

### 3.2 修复方案

```
1. apps/web/package.json:  "next": "14.2.35" → "15.5.21"
2. 根 package.json:        运行 pnpm update 更新锁文件中的子依赖
3. 验证: pnpm audit --audit-level=high → 0 vulnerabilities
4. 验证: pnpm audit --audit-level=moderate → 确认仅剩低风险（可接受）
```

### 3.3 CI 安全门禁

在 `.github/workflows/ci.yml` 新增 job：

```yaml
security-audit:
  name: Security Audit
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with: { node-version: '22', cache: 'pnpm' }
    - run: pnpm install --frozen-lockfile
    - run: pnpm audit --audit-level=high
```

规则：high 或 critical 漏洞 → CI 失败 → 阻断合并。

### 3.4 Dependabot 配置

新建 `.github/dependabot.yml`：

```yaml
version: 2
updates:
  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'monthly'
    open-pull-requests-limit: 5
    labels: ['dependencies']

  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'daily'
    allow:
      - dependency-type: 'all'
    open-pull-requests-limit: 10
    labels: ['security']
    # Security updates only
    target-branch: 'main'
```

### 3.5 改动文件

| 文件                       | 改动                    | 行数 |
| -------------------------- | ----------------------- | ---- |
| `apps/web/package.json`    | next 版本升级           | ~1   |
| `pnpm-lock.yaml`           | 自动更新                | 自动 |
| `.github/workflows/ci.yml` | 新增 security-audit job | +15  |
| `.github/dependabot.yml`   | **新建**                | +20  |

---

## 四、子项 2 — 渗透测试套件

### 4.1 新增 SecurityGate 模块

`apps/cli/src/security/gate.ts`（新建）：

```
SecurityGate
├── checkPromptInjection(input: string): GateResult
├── checkPathTraversal(path: string, cwd: string): GateResult
├── checkBashCommand(command: string): GateResult
└── checkCredentialLeak(output: string): GateResult

GateResult = { blocked: boolean, reason?: string }
```

#### 4.1.1 Prompt Injection 检测

检测模式：

| 模式 | 正则 |
| ---------------------------------- | ----------------------------- | ---------------- | ------------------------------- | ------------ | ----- | ------------------------ | ------ | ------------ |
| "ignore all previous instructions" | `/ignore\s+(all\s+)?(previous | prior            | above)\s+(instructions?         | prompts?)/i` |
| Role impersonation | `/^system\s*:\s*(now\s+)?(act | pretend          | you\s+are)/im` |
| Delimiter injection | `/(^                          | \n)(---\s\*BEGIN | <\|\w+\|>)/` |
| "You are now DAN" | `/you\s+are\s+now\s+(dan      | jailbroken       | unrestricted)/i` |
| Override attempts | `/(disregard                  | override         | supersede)\s+(all\s+)?(previous | prior        | above | system)\s+(instructions? | rules? | prompts?)/i` |

返回 `{ blocked: true, reason: 'prompt injection detected: <pattern>' }`。

#### 4.1.2 Path Traversal 增强

在现有 `resolveSafe()` 基础上增加：

- Null byte 检测: `/\0/` — 拒绝
- 双编码检测: `/%25/i` 或 `%2e%2e` 模式 — 拒绝
- Windows 路径分隔符: 非 Windows 平台拒绝 `\` 分隔符

#### 4.1.3 Bash 命令注入检测

危险模式：

| 模式                                     | 说明                 |
| ---------------------------------------- | -------------------- |
| `$(...)` 或 `` `...` ``                  | 命令替换             |
| `; rm` / `; cat` / `\| sh`               | 命令链注入           |
| `> /dev/` / `> /etc/`                    | 输出重定向到系统路径 |
| `curl ... \| sh` / `wget ... -O - \| sh` | 下载执行             |

#### 4.1.4 凭证泄露检测

扫描输出中的 API key 模式：

- `sk-ant-` (Anthropic)
- `sk-` 前缀 32+ 字符 (OpenAI 兼容)
- `eyJ` JWT token
- `x-api-key:` header

### 4.2 渗透测试文件

`apps/cli/test/security/penetration/`：

| #   | 文件                            | 攻击向量           | 测试数  |
| --- | ------------------------------- | ------------------ | ------- |
| 1   | `prompt-injection.test.ts`      | System Prompt 突破 | 6       |
| 2   | `path-traversal.test.ts`        | 路径穿越           | 5       |
| 3   | `ssrf-bypass.test.ts`           | SSRF 绕过          | 5       |
| 4   | `permission-escalation.test.ts` | 权限提升           | 5       |
| 5   | `credential-leak.test.ts`       | 凭证泄露           | 5       |
| 6   | `command-injection.test.ts`     | 命令注入           | 5       |
|     |                                 | **合计**           | **~31** |

### 4.3 渗透测试 CI

```yaml
penetration-test:
  name: Penetration Tests
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with: { node-version: '22', cache: 'pnpm' }
    - run: pnpm install --frozen-lockfile
    - run: cd apps/cli && pnpm test -- test/security/penetration/
```

### 4.4 改动文件

| 文件                                                      | 改动                       | 行数 |
| --------------------------------------------------------- | -------------------------- | ---- |
| `src/security/gate.ts`                                    | **新建** — SecurityGate 类 | ~120 |
| `test/security/penetration/prompt-injection.test.ts`      | **新建**                   | ~50  |
| `test/security/penetration/path-traversal.test.ts`        | **新建**                   | ~40  |
| `test/security/penetration/ssrf-bypass.test.ts`           | **新建**                   | ~40  |
| `test/security/penetration/permission-escalation.test.ts` | **新建**                   | ~40  |
| `test/security/penetration/credential-leak.test.ts`       | **新建**                   | ~50  |
| `test/security/penetration/command-injection.test.ts`     | **新建**                   | ~40  |
| `.github/workflows/ci.yml`                                | 新增 penetration-test job  | +10  |

---

## 五、子项 3 — 密钥轮换自动化

### 5.1 数据模型

`~/.mipham/keys.json`：

```json
{
  "deepseek": {
    "createdAt": "2026-08-07T10:00:00Z",
    "lastRotated": "2026-08-07T10:00:00Z",
    "rotationCount": 0,
    "provider": "deepseek"
  }
}
```

字段说明：

| 字段            | 类型     | 说明                 |
| --------------- | -------- | -------------------- |
| `createdAt`     | ISO 8601 | 首次记录时间         |
| `lastRotated`   | ISO 8601 | 上次轮换时间         |
| `rotationCount` | number   | 轮换次数             |
| `provider`      | string   | 对应的 provider 名称 |

> **安全约束**: `keys.json` 不存储 API key 实际值。key 值仅存在于 `~/.mipham/config.json`（已有）和环境变量中。

### 5.2 KeyManager 类

`apps/cli/src/config/keys-manager.ts`（新建）：

```typescript
class KeyManager {
  // 列出所有 provider 的 key 状态（不显示 key 值）
  list(): KeyStatus[]

  // 轮换指定 provider 的 key
  rotate(provider: string, newKey: string): RotateResult

  // 审计所有 key 的年龄
  audit(): AuditResult[]

  // 检查是否有过期 key（>90 天），返回提醒文本
  getExpiryReminder(): string | null
}

interface KeyStatus {
  provider: string
  createdAt: string
  lastRotated: string
  rotationCount: number
  ageDays: number
  expired: boolean // > 90 days
}
```

### 5.3 CLI 命令

| 命令                            | 行为                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `mipham keys list`              | 表格显示所有 provider 的 key 状态                                                                                           |
| `mipham keys rotate <provider>` | 交互式：提示输入新 key → 备份旧 key 到 `~/.mipham/keys/<provider>.backup` → `chmod 600` → 更新 config.json → 更新 keys.json |
| `mipham keys audit`             | 检查所有 key，标记 > 90 天未轮换的                                                                                          |

Slash 命令注册（`/keys`）：

```
/keys             → 等同于 mipham keys list（列出状态）
/keys rotate <p>  → 等同于 mipham keys rotate <provider>
/keys audit       → 等同于 mipham keys audit
```

### 5.4 SessionStart 提醒

在 `index.tsx` 启动时：

```typescript
const reminder = keyManager.getExpiryReminder()
if (reminder) {
  prompt += `\n\n⚠️  ${reminder}\n执行 /keys rotate <provider> 进行轮换。`
}
```

提醒示例：

```
⚠️  DeepSeek API key 已 95 天未轮换（超过 90 天建议周期）。
执行 /keys rotate deepseek 进行轮换。
```

### 5.5 安全措施

| 措施       | 说明                                                          |
| ---------- | ------------------------------------------------------------- |
| 文件权限   | `keys.json` 和 `.backup` 文件 `chmod 600`                     |
| 无明文展示 | `keys list` 和 `keys audit` 永不输出实际 key 值               |
| 原子写入   | 备份和更新使用 tmp + rename 原子操作                          |
| 备份加密   | `.backup` 文件路径仅 owner 可读，不做额外加密（避免循环依赖） |

### 5.6 改动文件

| 文件                         | 改动                           | 行数 |
| ---------------------------- | ------------------------------ | ---- |
| `src/config/keys-manager.ts` | **新建** — KeyManager 类       | ~80  |
| `src/commands/keys.ts`       | **新建** — keys 命令实现       | ~60  |
| `src/ui/commands.ts`         | 注册 `/keys` 命令              | +15  |
| `src/index.tsx`              | SessionStart 注入 key 过期提醒 | +10  |
| `test/commands/keys.test.ts` | **新建** — 8 个测试            | ~60  |

---

## 六、CI 流水线全貌（Phase 8 后）

```
CI Pipeline:
  Type Check → Lint → Format Check → Build CLI → Build Web → Test → Security Audit → Penetration Tests
```

- **Security Audit**: `pnpm audit --audit-level=high` — 阻断 high/critical 漏洞
- **Penetration Tests**: `pnpm test -- test/security/penetration/` — 阻断安全回退

---

## 七、风险与回滚

| 风险                             | 缓解                                                |
| -------------------------------- | --------------------------------------------------- |
| Next.js 15 升级可能破坏 Web 页面 | 先在本地验证 `pnpm build` + 页面渲染                |
| 渗透测试误报                     | SecurityGate 检查只记录不阻断（观测模式），逐步收紧 |
| 密钥轮换时 config 损坏           | 原子写入 + 备份文件可手动恢复                       |
| Dependabot PR 洪水               | 限制 open PR 数：monthly 5 + security 10            |

---

## 八、不做什么（明确排除）

- ❌ 不做完整 SAST（静态代码扫描）工具集成 — 超出 CLI 工具范围
- ❌ 不做 SOC2/ISO27001 合规审计 — 组织层面事务
- ❌ 不实现密钥服务器/HSM 集成 — Phase 8 聚焦本地轮换
- ❌ 不做运行时 WAF/RASP — 不在 CLI 工具范围内
- ❌ 不引入第三方安全库（如 helmet、rate-limiter）— 最小依赖

---

### 修订历史

| 版本  | 日期       | 变更内容               | 维护人     |
| ----- | ---------- | ---------------------- | ---------- |
| 1.0.0 | 2026-08-07 | 初版：三子系统完整设计 | 技术委员会 |
