import type {
  MiphamConfig,
  InferenceHookConfig,
  CredentialMaskingConfig,
  BackgroundAgentConfig,
  CrossSessionConfig,
} from '../shared/index.ts'
import { DEFAULT_PROVIDERS } from '../shared/index.ts'
import { PACKAGE_VERSION } from '../shared/index.ts'

export const DEFAULT_CONFIG: MiphamConfig = {
  version: PACKAGE_VERSION,
  defaultProvider: 'deepseek',
  defaultModel: 'deepseek-v4-pro',
  permission: 'default',
  showThinking: 'off',
  showSchedulingNotices: false,
  showCommandPicker: false,
  autocomplete: {
    enabled: true,
    debounceMs: 400,
  },
  // Org 级权限限制（可选）：forbiddenModes 禁指定模式 / maxAllowedMode 封顶层级；
  // 请求被禁模式时 fail-closed 降级（如 forbiddenModes:['bypassPermissions']）。
  // permissionRestrictions: { forbiddenModes: ['bypassPermissions'] },
  // 用户自定义权限规则（可选）：allow/deny 接入运行时 PermissionSystem。
  // mask 与 deny 互补、勿重叠（重叠则 deny 先触发、mask 轮不到 → 白做）：
  //   - mask（credential_masking，默认开启）管「可读但含机密」：.env / .ssh/id_* / *.pem / *.key…
  //   - deny 管「根本不该碰」且未被 mask 覆盖的文件：.git-credentials / .npmrc / .kube/config…
  // permissionRules: { deny: ['Read(**/.git-credentials)', 'Read(**/.npmrc)'] },
  providers: DEFAULT_PROVIDERS,
  marketplace: {
    strictKnownMarketplaces: [],
    blockedMarketplaces: [],
  },
  features: {
    mcp: { oauthEnabled: true },
    context: { adaptiveThresholds: true },
  },
  crsi: {
    ruleInjection: true,
    preToolHook: true,
    autoPatternAnalysis: true,
    autoRuleManagement: true,
  },
}

export const DEFAULT_INFERENCE_HOOK_CONFIG: InferenceHookConfig = {
  endpoint: '',
  signing_secret: '',
  timeout: 5000,
  on_failure: 'fail-closed',
  organization_id: '',
  headers: {},
}

export const DEFAULT_CREDENTIAL_MASKING_CONFIG: CredentialMaskingConfig = {
  enabled: true,
  // Default sensitive-file rules: full-mask any of these before the model sees them.
  files: [
    { path: '**/.env*', mode: 'full' },
    { path: '**/.aws/credentials', mode: 'full' },
    { path: '**/.aws/config', mode: 'full' },
    { path: '**/.ssh/id_*', mode: 'full' },
    { path: '**/*.pem', mode: 'full' },
    { path: '**/*.key', mode: 'full' },
    { path: '**/.netrc', mode: 'full' },
    { path: '**/credentials.*', mode: 'full' },
  ],
  output_scrubbing: {
    enabled: true,
    // 名字那一段：`_key` 出现在标识符**中间**也算（`AWS_ACCESS_KEY_ID=…`），但**不许吞掉
    // 词后面的字符** —— 否则 `"keys": […]`、`total tokens: 1234` 这类**不是秘密**的输出
    // 会被整段擦掉。中间那对引号可选，为的是 JSON 形状的 `"apiKey": "…"`。
    patterns: [
      '(?i)(api[_-]?key|[A-Za-z0-9_.-]*[_-]key[A-Za-z0-9_.-]*|secret|token|password|credential|[_-]pat)["\']?\\s*[:=]\\s*["\']?\\S+',
    ],
  },
  env_filter: {
    enabled: true,
    // 按**词**匹配，不是按后缀：`AWS_ACCESS_KEY_ID`（词在中间）、`GH_PAT`、`HTTP_AUTHORIZATION`
    // 都算，而 `MONKEY` / `KEYBOARD_LAYOUT` 不算。
    //
    // 这个限定是必需的，不是洁癖：`AUTH` 若按**段**匹配，`SSH_AUTH_SOCK` 会被掩掉 ——
    // Bash 里的 ssh / git push 当场找不到 agent；`KEY` 若按**子串**匹配，`MONKEY`、
    // `KEYBOARD_LAYOUT` 中招。同理 `PWD` 只认 `_PWD$`（`MYSQL_PWD`），不认裸 `PWD`。
    patterns: [
      '(?i)(^|_)(KEY|APIKEY|TOKEN|SECRET)(_|$)',
      '(?i)(PASSWORD|CREDENTIAL)',
      '(?i)(^|_)(AUTH|AUTHORIZATION|PAT)$',
      '(?i)_PWD$',
    ],
  },
}

export const DEFAULT_BACKGROUND_AGENT_CONFIG: BackgroundAgentConfig = {
  auto_commit: true,
  auto_push: true,
  auto_worktree: true,
  commit_coauthors: true,
}

export const DEFAULT_CROSS_SESSION_CONFIG: CrossSessionConfig = {
  crossSessionInbound: 'ask',
  dialogExpiry: 300,
}
