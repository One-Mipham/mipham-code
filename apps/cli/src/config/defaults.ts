import type { MiphamConfig, InferenceHookConfig, CredentialMaskingConfig, BackgroundAgentConfig } from '../shared/index.ts'
import { DEFAULT_PROVIDERS } from '../shared/index.ts'
import { PACKAGE_VERSION } from '../shared/index.ts'

export const DEFAULT_CONFIG: MiphamConfig = {
  version: PACKAGE_VERSION,
  defaultProvider: 'deepseek',
  defaultModel: 'deepseek-v4-pro',
  permission: 'auto',
  providers: DEFAULT_PROVIDERS,
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
  files: [],
  output_scrubbing: {
    enabled: true,
    patterns: ['(?i)(api[_-]?key|secret|token|password|credential)\\s*[:=]\\s*\\S+'],
  },
  env_filter: {
    enabled: true,
    patterns: ['(?i)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)$'],
  },
}

export const DEFAULT_BACKGROUND_AGENT_CONFIG: BackgroundAgentConfig = {
  auto_commit: true,
  auto_push: true,
  auto_worktree: true,
  commit_coauthors: true,
}
