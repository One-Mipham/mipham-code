import { EventEmitter } from 'node:events'

export type WorkflowEvent =
  | { type: 'phase:start'; phase: string; timestamp: number }
  | { type: 'phase:end'; phase: string; timestamp: number }
  | { type: 'agent:start'; agentId: string; label: string; phase: string }
  | { type: 'agent:end'; agentId: string; label: string; success: boolean; durationMs: number }
  | { type: 'agent:result'; agentId: string; summary: string }
  | { type: 'log'; message: string }
  | { type: 'error'; agentId?: string; message: string }
  | { type: 'done'; runId: string; totalAgents: number; cacheHits: number }

export class WorkflowEventBus extends EventEmitter {
  private activeRunId: string | null = null

  startRun(runId: string): void {
    this.activeRunId = runId
  }

  emitEvent(event: WorkflowEvent): void {
    this.emit(event.type, event)
  }

  getActiveRunId(): string | null {
    return this.activeRunId
  }
}

let instance: WorkflowEventBus | null = null

export function getEventBus(): WorkflowEventBus {
  if (!instance) {
    instance = new WorkflowEventBus()
  }
  return instance
}
