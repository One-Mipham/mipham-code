import type { ProviderConfig, ModelInfo, Message, StreamChunk } from '../shared/index.ts'
import type { Llm } from './llm'
import { getMetrics } from '../core/metrics'

/**
 * The model a secondary call should use when it wants speed rather than depth:
 * the first active model whose id looks like a small one, else whatever is
 * active. Exported so the permission classifier and `self-critique` pick the
 * same model — two private copies of this heuristic would drift apart silently.
 */
export function pickFastestModel(registry: ProviderRegistry): string {
  const models = registry.listModels?.() ?? []
  const flash = models.find(
    (m) => m.id.toLowerCase().includes('flash') || m.id.toLowerCase().includes('1.5b'),
  )
  return flash ? flash.id : registry.getActiveModel()
}

/**
 * Resolve `permissions.classifierModel` to a model id.
 *
 * Three inputs, three meanings — and the default is the point:
 *
 *  - absent / `'active'` ⇒ the operator's own model. A gate that quietly
 *    downgraded to a cheaper judge would make `auto` mean "judged by something
 *    you did not pick", and the two models do not agree on borderline calls
 *    (measured 2026-09-30: the fast one allowed 8/20 that the reasoning one
 *    blocked, 2/20 the other way).
 *  - `'fast'` ⇒ `pickFastestModel`, falling back to the active model rather
 *    than inventing an id that may not exist.
 *  - anything else ⇒ used verbatim. Whether it exists is the provider's to say;
 *    a second registry here would be a second value domain that drifts.
 */
export function resolveClassifierModel(
  choice: string | undefined,
  registry: ProviderRegistry,
): string {
  if (choice === undefined || choice === '' || choice === 'active') return registry.getActiveModel()
  if (choice === 'fast') return pickFastestModel(registry)
  return choice
}

export interface ProviderInstance {
  config: ProviderConfig
  chat(req: ChatRequest): AsyncGenerator<StreamChunk>
  listModels(): Promise<ModelInfo[]>
  healthCheck(): Promise<boolean>
}

export interface ChatRequest {
  model: string
  messages: Message[]
  systemPrompt?: string
  tools?: Record<string, unknown>[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** Reasoning effort (low|medium|high|xhigh|max) — scales the streaming idle timeout. */
  effort?: string
}

export class ProviderRegistry implements Llm {
  private providers = new Map<string, ProviderInstance>()
  private activeProviderId: string
  private activeModelId: string
  private defaultProviderId: string
  private defaultModelId: string

  constructor(providers: ProviderConfig[], defaultProvider: string, defaultModel: string) {
    this.activeProviderId = defaultProvider
    this.activeModelId = defaultModel
    this.defaultProviderId = defaultProvider
    this.defaultModelId = defaultModel
  }

  /** The configured default provider id (used for fallback routing). */
  getDefaultProviderId(): string {
    return this.defaultProviderId
  }

  /** The configured default model id. */
  getDefaultModelId(): string {
    return this.defaultModelId
  }

  register(id: string, instance: ProviderInstance): void {
    this.providers.set(id, instance)
  }

  get(id: string): ProviderInstance | undefined {
    return this.providers.get(id)
  }

  getActive(): ProviderInstance {
    const p = this.providers.get(this.activeProviderId)
    if (!p) throw new Error(`Provider "${this.activeProviderId}" not registered`)
    return p
  }

  getActiveModel(): string {
    return this.activeModelId
  }

  switchProvider(providerId: string, modelId?: string): void {
    if (!this.providers.has(providerId)) {
      throw new Error(
        `Provider "${providerId}" not registered. Available: ${this.listIds().join(', ')}`,
      )
    }
    this.activeProviderId = providerId
    if (modelId) this.activeModelId = modelId
  }

  listIds(): string[] {
    return Array.from(this.providers.keys())
  }

  listModels(): ModelInfo[] {
    const provider = this.getActive()
    return provider.config.models.filter((m) => m.status === 'active')
  }

  findModel(modelId: string): ModelInfo | undefined {
    for (const provider of this.providers.values()) {
      const model = provider.config.models.find((m) => m.id === modelId)
      if (model) return model
    }
    return undefined
  }

  /**
   * Check a single provider's health. Returns undefined if not registered,
   * otherwise the provider's healthCheck() result. Never throws.
   */
  async healthStatus(id: string): Promise<boolean | undefined> {
    const provider = this.providers.get(id)
    if (!provider) return undefined
    try {
      return await provider.healthCheck()
    } catch {
      return false
    }
  }

  /**
   * Health of all registered providers, checked concurrently.
   * Returns a Map of provider id → reachable boolean.
   */
  async healthMap(): Promise<Map<string, boolean>> {
    const ids = this.listIds()
    const results = await Promise.all(
      ids.map(async (id) => [id, (await this.healthStatus(id)) ?? false] as const),
    )
    return new Map(results)
  }

  async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const provider = this.getActive()
    const providerId = this.activeProviderId
    const modelId = req.model || this.activeModelId
    const metrics = getMetrics()
    const start = Date.now()
    metrics.modelRequests.inc({ provider: providerId, model: modelId })
    try {
      for await (const chunk of provider.chat({ ...req, model: modelId })) {
        if (chunk.type === 'error') {
          metrics.modelRequestErrors.inc({ provider: providerId, error_type: 'api_error' })
        }
        yield chunk
      }
    } catch (err) {
      metrics.modelRequestErrors.inc({ provider: providerId, error_type: 'exception' })
      throw err
    } finally {
      metrics.modelRequestDurationMs.observe(Date.now() - start, { provider: providerId })
    }
  }
}
