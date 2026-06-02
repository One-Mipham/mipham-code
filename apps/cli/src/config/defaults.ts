import type { MiphamConfig } from './shared/index.ts'
import { DEFAULT_PROVIDERS } from './shared/index.ts'

export const DEFAULT_CONFIG: MiphamConfig = {
  version: '0.1.0',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  permission: 'auto',
  providers: DEFAULT_PROVIDERS,
}
