import type { MiphamConfig } from '../shared/index.ts'
import { DEFAULT_PROVIDERS } from '../shared/index.ts'
import { PACKAGE_VERSION } from '@mipham/shared'

export const DEFAULT_CONFIG: MiphamConfig = {
  version: PACKAGE_VERSION,
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  permission: 'auto',
  providers: DEFAULT_PROVIDERS,
}
