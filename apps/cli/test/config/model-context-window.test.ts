import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate from the real ~/.mipham — loadConfig() reads (and may create) config.yml there.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-model-context-window`,
  }
})

import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from '../../src/config/loader'
import { ContextManager } from '../../src/core/context'

const MIPHAM_HOME = join(homedir(), '.mipham')
const CWD = join(homedir(), 'proj')

function writeUserConfig(yaml: string): void {
  mkdirSync(MIPHAM_HOME, { recursive: true })
  writeFileSync(join(MIPHAM_HOME, 'config.yml'), yaml, 'utf-8')
}

function customProvider(modelsYaml: string): string {
  return [
    'defaultProvider: local',
    'defaultModel: my-model',
    'providers:',
    '  - id: local',
    '    name: Local',
    '    protocol: openai-compatible',
    '    baseUrl: http://127.0.0.1:11434/v1',
    '    apiKey: not-a-secret',
    '    models:',
    modelsYaml,
  ].join('\n')
}

// ============================================================
// 手写 model 缺 contextWindow 时，上下文窗口不能被算成 undefined。
//
// 链路：YAML 的 providers[].models 原样进 registry（loader.ts 只做合并，不校验）；
// index.tsx 用 registry.findModel(defaultModel).contextWindow 当 maxTokens；而
// ContextManager.needsCompaction() 是 `estimated > maxTokens * threshold`。
// maxTokens 为 undefined 时这个比较是 `> NaN` —— 恒 false，于是自动压缩**永不触发**，
// 且全程没有任何报错：用户只会在大上下文时收到上游的 400。
//
// 修复：loadConfig 出口统一把缺失/非法的 contextWindow 回退到 128K 并告警。
// 128K 与 index.tsx 对「未知模型」的回退值一致。
// ============================================================
describe('loadConfig — 手写 model 的 contextWindow 回退', () => {
  let stderr: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(MIPHAM_HOME, { recursive: true })
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    stderr.mockRestore()
  })

  it('缺失 contextWindow 时回退到 128K，并且自动压缩真的能触发', () => {
    writeUserConfig(
      customProvider(
        [
          '      - id: my-model',
          '        name: My Model',
          '        providerId: local',
          '        maxOutput: 4096',
          '        vision: false',
          '        status: active',
        ].join('\n'),
      ),
    )

    const config = loadConfig(CWD)
    const model = config.providers.find((p) => p.id === 'local')!.models[0]!

    expect(model.contextWindow).toBe(128_000)

    // 端到端症状：index.tsx 正是这样把窗口交给 ContextManager 的。
    const context = new ContextManager({
      maxTokens: model.contextWindow,
      compactionThreshold: 0.9,
      contextWindow: model.contextWindow,
    })
    // 500K 字符 ≈ 125K token，超过 128K × 0.9。
    context.addMessage({ role: 'user', content: 'x'.repeat(500_000) })
    expect(context.needsCompaction()).toBe(true)
  })

  it('非法值（0 / 负数 / 字符串）同样回退到 128K', () => {
    writeUserConfig(
      customProvider(
        [
          '      - id: my-model',
          '        name: Zero',
          '        providerId: local',
          '        contextWindow: 0',
          '        maxOutput: 4096',
          '        vision: false',
          '        status: active',
          '      - id: negative',
          '        name: Negative',
          '        providerId: local',
          '        contextWindow: -1',
          '        maxOutput: 4096',
          '        vision: false',
          '        status: active',
          '      - id: quoted',
          '        name: Quoted',
          '        providerId: local',
          '        contextWindow: "200000"',
          '        maxOutput: 4096',
          '        vision: false',
          '        status: active',
        ].join('\n'),
      ),
    )

    const models = loadConfig(CWD).providers.find((p) => p.id === 'local')!.models
    expect(models.map((m) => m.contextWindow)).toEqual([128_000, 128_000, 128_000])
  })

  it('显式声明的合法窗口不被改写，也不告警', () => {
    writeUserConfig(
      customProvider(
        [
          '      - id: my-model',
          '        name: My Model',
          '        providerId: local',
          '        contextWindow: 32000',
          '        maxOutput: 4096',
          '        vision: false',
          '        status: active',
        ].join('\n'),
      ),
    )

    const model = loadConfig(CWD).providers.find((p) => p.id === 'local')!.models[0]!
    expect(model.contextWindow).toBe(32_000)
    expect(stderr.mock.calls.map((c: unknown[]) => String(c[0])).join('')).not.toContain(
      'contextWindow',
    )
  })

  it('回退时告警，点名模型与 provider（不能静默）', () => {
    writeUserConfig(
      customProvider(
        [
          '      - id: my-model',
          '        name: My Model',
          '        providerId: local',
          '        maxOutput: 4096',
          '        vision: false',
          '        status: active',
        ].join('\n'),
      ),
    )

    loadConfig(CWD)

    const messages = stderr.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    expect(messages).toContain('my-model')
    expect(messages).toContain('local')
    expect(messages).toContain('128K')
  })
})
