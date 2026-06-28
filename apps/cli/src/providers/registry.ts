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

  constructor(providers: ProviderConfig[], defaultProvider: string, defaultModel: string) {
    this.activeProviderId = defaultProvider
    this.activeModelId = defaultModel
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

  async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const provider = this.getActive()
    yield* provider.chat({ ...req, model: req.model || this.activeModelId })
  }
}
