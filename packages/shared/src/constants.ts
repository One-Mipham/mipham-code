import type { ProviderConfig } from './types'

// Providers: alphabetical by id. Models: Lite/Flash → Text → Vision → Code → Pro/Think
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'anthropic', name: 'Anthropic Claude', protocol: 'anthropic', apiKey: '${ANTHROPIC_API_KEY}',
    models: [
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', providerId: 'anthropic', contextWindow: 200_000, maxOutput: 32_000, vision: true, status: 'active' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', providerId: 'anthropic', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', providerId: 'anthropic', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, status: 'active' },
    ],
  },
  {
    id: 'deepseek', name: 'DeepSeek', protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', apiKey: '${DEEPSEEK_API_KEY}',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', providerId: 'deepseek', contextWindow: 1_000_000, maxOutput: 384_000, vision: false, status: 'active' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', providerId: 'deepseek', contextWindow: 1_000_000, maxOutput: 384_000, vision: false, status: 'active' },
    ],
  },
  {
    id: 'google', name: 'Google Gemini', protocol: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '${GEMINI_API_KEY}',
    models: [
      { id: 'gemini-3.0-flash', name: 'Gemini 3.0 Flash', providerId: 'google', contextWindow: 1_000_000, maxOutput: 64_000, vision: true, status: 'active' },
      { id: 'gemini-3.0-pro', name: 'Gemini 3.0 Pro', providerId: 'google', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', providerId: 'google', contextWindow: 1_000_000, maxOutput: 64_000, vision: true, status: 'active' },
    ],
  },
  {
    id: 'doubao', name: '豆包 (字节跳动)', protocol: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: '${DOUBAO_API_KEY}',
    models: [
      { id: 'doubao-seed-1.6-flash', name: '豆包 Seed 1.6 Flash', providerId: 'doubao', contextWindow: 256_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'doubao-seed-2.0-mini', name: '豆包 Seed 2.0 Mini', providerId: 'doubao', contextWindow: 256_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'doubao-seed-2.0-lite', name: '豆包 Seed 2.0 Lite', providerId: 'doubao', contextWindow: 256_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'doubao-seed-1.6', name: '豆包 Seed 1.6', providerId: 'doubao', contextWindow: 256_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'doubao-seed-2.0-pro', name: '豆包 Seed 2.0 Pro', providerId: 'doubao', contextWindow: 256_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'doubao-seed-2.0-code', name: '豆包 Seed 2.0 Code', providerId: 'doubao', contextWindow: 256_000, maxOutput: 128_000, vision: true, status: 'active' },
    ],
  },
  {
    id: 'hunyuan', name: '腾讯混元', protocol: 'openai-compatible', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', apiKey: '${HUNYUAN_API_KEY}',
    models: [
      { id: 'hunyuan-lite', name: '混元 Lite (免费)', providerId: 'hunyuan', contextWindow: 256_000, maxOutput: 6_000, vision: false, status: 'active' },
      { id: 'hunyuan-turbos-latest', name: '混元 TurboS', providerId: 'hunyuan', contextWindow: 32_000, maxOutput: 16_000, vision: false, status: 'active' },
      { id: 'hunyuan-2.0-instruct-20251111', name: '混元 2.0 Instruct', providerId: 'hunyuan', contextWindow: 144_000, maxOutput: 16_000, vision: false, status: 'active' },
      { id: 'hunyuan-t1-vision-20250916', name: '混元 T1 Vision', providerId: 'hunyuan', contextWindow: 32_000, maxOutput: 64_000, vision: true, status: 'active' },
      { id: 'hunyuan-a13b', name: '混元 A13B', providerId: 'hunyuan', contextWindow: 224_000, maxOutput: 32_000, vision: false, status: 'active' },
      { id: 'hunyuan-2.0-thinking-20251109', name: '混元 2.0 Think', providerId: 'hunyuan', contextWindow: 192_000, maxOutput: 64_000, vision: false, status: 'active' },
      { id: 'hunyuan-t1-latest', name: '混元 T1 (推理)', providerId: 'hunyuan', contextWindow: 32_000, maxOutput: 64_000, vision: false, status: 'active' },
      { id: 'hy3-preview', name: '混元 Hy3 Preview', providerId: 'hunyuan', contextWindow: 256_000, maxOutput: 128_000, vision: false, status: 'active' },
    ],
  },
  {
    id: 'mipham', name: 'MiphamAI', protocol: 'openai-compatible',
    baseUrl: 'https://api.mipham.ai/v1', apiKey: '${MIPHAM_API_KEY}',
    models: [
      { id: 'om-v5-flash', name: 'OM V5 Flash', providerId: 'mipham', contextWindow: 1_000_000, maxOutput: 128_000, vision: false, status: 'upcoming' },
      { id: 'om-v5-pro', name: 'OM V5 Pro', providerId: 'mipham', contextWindow: 1_000_000, maxOutput: 128_000, vision: false, status: 'upcoming' },
      { id: 'om-v5-image', name: 'OM V5 Image', providerId: 'mipham', contextWindow: 200_000, maxOutput: 32_000, vision: true, status: 'upcoming' },
    ],
    status: 'upcoming',
  },
  {
    id: 'openai', name: 'OpenAI', protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: '${OPENAI_API_KEY}',
    models: [
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', providerId: 'openai', contextWindow: 400_000, maxOutput: 32_000, vision: true, status: 'active' },
      { id: 'gpt-5.4', name: 'GPT-5.4', providerId: 'openai', contextWindow: 1_050_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'gpt-5.5', name: 'GPT-5.5', providerId: 'openai', contextWindow: 1_050_000, maxOutput: 128_000, vision: true, status: 'active' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', providerId: 'openai', contextWindow: 400_000, maxOutput: 64_000, vision: false, status: 'active' },
    ],
  },
  {
    id: 'qwen', name: '通义千问', protocol: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '${QWEN_API_KEY}',
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus', providerId: 'qwen', contextWindow: 128_000, maxOutput: 32_000, vision: true, status: 'active' },
      { id: 'qwen-max', name: 'Qwen Max', providerId: 'qwen', contextWindow: 128_000, maxOutput: 32_000, vision: true, status: 'active' },
    ],
  },
]

export const PROTOCOL_LABELS: Record<string, string> = {
  'openai-compatible': 'OpenAI Compatible',
  'anthropic': 'Anthropic',
  'custom': 'Custom Protocol',
}

export const TOOL_CATEGORIES = ['file', 'exec', 'agent', 'network', 'system'] as const
export const CONFIG_FILE_NAME = 'config.yml'
export const MIPHAM_DIR = '.mipham'
export const USER_CONFIG_DIR = '.mipham'
export const MEMORY_DIR = 'memory'
