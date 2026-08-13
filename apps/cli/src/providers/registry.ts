import type { ProviderConfig, ModelInfo, Message, StreamChunk } from '../shared/index.ts'

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
}

export class ProviderRegistry {
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
    yield* provider.chat({ ...req, model: req.model || this.activeModelId })
  }
}
