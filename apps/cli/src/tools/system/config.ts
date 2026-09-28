import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import { atomicWriteFileSync } from '../../shared/atomic-write'
import { ENC_PREFIX, encryptApiKey, getCredentialKey } from '../../config/credential-crypto'
import type { ToolDefinition } from '../../shared/index.ts'
import { miphamHome } from '../../core/paths.ts'

const MIPHAM_HOME = miphamHome()
const USER_CONFIG = join(MIPHAM_HOME, 'config.yml')

export const configTool: ToolDefinition = {
  name: 'Config',
  description: 'Read or update Mipham Code configuration.',
  category: 'system',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'list'],
        description: 'Action to perform',
      },
      key: { type: 'string', description: 'Config key (dot notation)' },
      value: { type: 'string', description: 'Value to set' },
    },
    required: ['action'],
  },
  async execute(params, _ctx) {
    mkdirSync(MIPHAM_HOME, { recursive: true })
    const action = params.action as string

    let config: Record<string, unknown> = {}
    if (existsSync(USER_CONFIG)) {
      config = parseYaml(readFileSync(USER_CONFIG, 'utf-8')) as Record<string, unknown>
    }

    if (action === 'list') {
      return { success: true, content: stringify(config) || '(empty config)' }
    }

    const key = params.key as string
    if (!key) return { success: false, content: '', error: 'key is required for get/set' }

    if (action === 'get') {
      const value = key.split('.').reduce((obj: unknown, k) => {
        if (obj && typeof obj === 'object') {
          return (obj as Record<string, unknown>)[k]
        }
        return undefined
      }, config)
      return { success: true, content: JSON.stringify(value) }
    }

    if (action === 'set') {
      const keys = key.split('.')
      let obj: Record<string, unknown> = config
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]!
        if (!obj[k]) obj[k] = {}
        obj = obj[k] as Record<string, unknown>
      }
      const last = keys[keys.length - 1]!
      let value = params.value
      // provider 的 apiKey 是凭据，而**读**侧早已把 `enc:v1:` 当成它的 at-rest 形态
      // （`loadConfig` → `decryptProviderApiKeys`、`getProviderApiKey`）。写侧却有两条路写
      // **同一份**文件 —— `saveProviderApiKey`（加密）与这里（不加密）—— 于是「密钥在盘上
      // 是密文」这条保证取决于用户从哪个写者进来，从这里进来的那份**静默降级**为明文。
      // 这里复用 `encryptApiKey` 本身，而不是重写一遍它的判断：什么算秘密（空值与 env 模板
      // 放行）只有一个定义，两份判断迟早分叉。调用侧只补它没有的那一条 —— 已加密的不再套
      // 一层（套两层不报错，只会让读侧解出一段密文，报错还指向别处）。
      if (
        keys.length === 3 &&
        keys[0] === 'providers' &&
        last === 'apiKey' &&
        typeof value === 'string' &&
        !value.startsWith(ENC_PREFIX)
      ) {
        value = encryptApiKey(value, getCredentialKey(MIPHAM_HOME))
      }
      obj[last] = value
      // 原子写 + 0o600：这是整份 read-modify-write，裸 writeFileSync 原地截断 ——
      // 崩在写中途就留下半截 YAML，而权限由 umask 决定（典型 0644），比同一份配置的
      // 另一个写者 saveProviderApiKey（loader.ts，0600 原子写）更松。
      atomicWriteFileSync(USER_CONFIG, stringify(config), { mode: 0o600 })
      // 回显**落盘的那个值**的形态，不由路径猜：env 模板与空值走的是同一条路，却明文落盘，
      // 按路径断言会把它说成「已加密」。密钥本身不回显 —— 它已经在写它的那次调用里了。
      const atRest = typeof value === 'string' && value.startsWith(ENC_PREFIX)
      return {
        success: true,
        content: atRest ? `Set ${key} (encrypted at rest)` : `Set ${key} = ${params.value}`,
      }
    }

    return { success: false, content: '', error: `Unknown action: ${action}` }
  },
}
