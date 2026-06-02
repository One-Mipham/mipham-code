import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { MiphamConfig } from '@mipham/shared'
import { DEFAULT_CONFIG } from './defaults'

export function loadConfig(cwd: string = process.cwd()): MiphamConfig {
  const configPath = join(cwd, '.mipham', 'config.yml')
  const userConfigPath = join(process.env.HOME || '~', '.mipham', 'config.yml')

  let config = { ...DEFAULT_CONFIG }

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8')
    const projectConfig = parseYaml(raw) as Partial<MiphamConfig>
    config = mergeConfig(config, projectConfig)
  }

  if (existsSync(userConfigPath)) {
    const raw = readFileSync(userConfigPath, 'utf-8')
    const userConfig = parseYaml(raw) as Partial<MiphamConfig>
    config = mergeConfig(config, userConfig)
  }

  return config
}

function mergeConfig(base: MiphamConfig, override: Partial<MiphamConfig>): MiphamConfig {
  return { ...base, ...override, providers: override.providers ?? base.providers }
}
