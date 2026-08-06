import type { MiphamConfig, InferenceHookConfig } from '../shared/index.ts'
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
