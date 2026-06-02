import type { Message } from './shared/index.ts'

interface ContextConfig {
  maxTokens: number
  compactionThreshold: number // e.g. 0.9 → compact at 90% usage
}

export class ContextManager {
  private messages: Message[] = []
  private systemPrompt = ''
  private estimatedTokens = 0

  constructor(private config: ContextConfig) {}

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
    this.estimatedTokens = this.estimateTokens(prompt)
  }

  getSystemPrompt(): string {
    return this.systemPrompt
  }

  addMessage(msg: Message): void {
    this.messages.push(msg)
    this.estimatedTokens += this.estimateTokens(
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    )
  }

  getMessages(): Message[] {
    return [...this.messages]
  }

  needsCompaction(): boolean {
    return this.estimatedTokens > this.config.maxTokens * this.config.compactionThreshold
  }

  async compact(_summarizeHeading: string): Promise<void> {
    // Phase 1: simple truncation — keep last 20 messages, drop oldest
    if (this.messages.length > 30) {
      const keep = 20
      this.messages = this.messages.slice(-keep)

      // Re-estimate tokens
      this.estimatedTokens = this.estimateTokens(this.systemPrompt)
      for (const msg of this.messages) {
        this.estimatedTokens += this.estimateTokens(
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        )
      }
    }
  }

  getEstimatedTokens(): number {
    return this.estimatedTokens
  }

  clear(): void {
    this.messages = []
    this.estimatedTokens = this.estimateTokens(this.systemPrompt)
  }

  private estimateTokens(text: string): number {
    // Simple estimation: ~4 chars per token
    return Math.ceil(text.length / 4)
  }
}
