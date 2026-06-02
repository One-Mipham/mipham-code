import type { MiphamConfig } from '@mipham/shared'
import { DEFAULT_PROVIDERS } from '@mipham/shared'

export const DEFAULT_CONFIG: MiphamConfig = {
  version: '0.1.0',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  permission: 'auto',
  providers: DEFAULT_PROVIDERS,
}
