import type { MiphamConfig } from '../shared/index.ts'
import { DEFAULT_PROVIDERS } from '../shared/index.ts'
import { PACKAGE_VERSION } from '../shared/index.ts'

export const DEFAULT_CONFIG: MiphamConfig = {
  version: PACKAGE_VERSION,
  defaultProvider: 'deepseek',
  defaultModel: 'deepseek-v4-pro',
  permission: 'auto',
  providers: DEFAULT_PROVIDERS,
}
