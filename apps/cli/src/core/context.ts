import type { Message } from '../shared/index.ts'

interface ContextConfig {
  maxTokens: number
  compactionThreshold: number // e.g. 0.9 → compact at 90% usage
}

interface Checkpoint {
  id: number
  messages: Message[]
  estimatedTokens: number
  timestamp: Date
  label: string
}

export class ContextManager {
  private messages: Message[] = []
  private systemPrompt = ''
  private estimatedTokens = 0
  private checkpoints: Checkpoint[] = []
  private checkpointCounter = 0

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
    this.checkpoints = []
    this.checkpointCounter = 0
    this.estimatedTokens = this.estimateTokens(this.systemPrompt)
  }

  getMessageCount(): number {
    return this.messages.length
  }

  // ── Checkpoint / Rewind ──

  saveCheckpoint(label = 'auto'): number {
    this.checkpointCounter++
    const checkpoint: Checkpoint = {
      id: this.checkpointCounter,
      messages: structuredClone(this.messages),
      estimatedTokens: this.estimatedTokens,
      timestamp: new Date(),
      label,
    }
    this.checkpoints.push(checkpoint)
    // Keep only last 10 checkpoints
    if (this.checkpoints.length > 10) {
      this.checkpoints = this.checkpoints.slice(-10)
    }
    return checkpoint.id
  }

  restoreCheckpoint(checkpointId?: number): {
    restored: boolean
    messageCount: number
    label: string
  } {
    // If no id given, restore the most recent checkpoint
    const target = checkpointId
      ? this.checkpoints.find((cp) => cp.id === checkpointId)
      : this.checkpoints.at(-1)

    if (!target) {
      return { restored: false, messageCount: this.messages.length, label: '' }
    }

    this.messages = structuredClone(target.messages)
    this.estimatedTokens = target.estimatedTokens
    return { restored: true, messageCount: this.messages.length, label: target.label }
  }

  getCheckpoints(): Array<{ id: number; messageCount: number; timestamp: Date; label: string }> {
    return this.checkpoints.map((cp) => ({
      id: cp.id,
      messageCount: cp.messages.length,
      timestamp: cp.timestamp,
      label: cp.label,
    }))
  }

  getLastCheckpointId(): number | undefined {
    return this.checkpoints.at(-1)?.id
  }

  private estimateTokens(text: string): number {
    // Simple estimation: ~4 chars per token
    return Math.ceil(text.length / 4)
  }
}
