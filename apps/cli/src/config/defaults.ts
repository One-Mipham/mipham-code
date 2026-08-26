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
    patterns: ['(?i)(api[_-]?key|secret|token|password|credential)\\s*[:=]\\s*\\S+'],
  },
  env_filter: {
    enabled: true,
    patterns: ['(?i)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)$'],
  },
}

/** 掩码中立配置：Read/Bash 照常挂载，但不启用任何凭据掩码（对齐 pre-seam 无参行为）。 */
export const DISABLED_CREDENTIAL_MASKING_CONFIG: CredentialMaskingConfig = {
  enabled: false,
  files: [],
  output_scrubbing: { enabled: false, patterns: [] },
  env_filter: { enabled: false, patterns: [] },
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
