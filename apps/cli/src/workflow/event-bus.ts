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
    // `error` here is a **payload type**, not EventEmitter's crash channel — and the
    // two are wired to the same string. Node makes `emit('error', …)` throw
    // ERR_UNHANDLED_ERROR when no listener is attached, so a workflow that failed
    // while nothing was watching the bus replaced its own diagnostic with
    // `Unhandled error. ({ type: 'error', message: '…' })`, and the carefully
    // written `throw new Error('Workflow script execution failed: …')` further down
    // never ran. It looked fine because the UI progress view subscribes to `error`,
    // so the throw only happened headless.
    //
    // Nothing is lost by skipping it: whoever needs the failure has the journal entry
    // and the thrown error; the one subscriber drops `error` on the floor anyway
    // (`workflow-progress.tsx`'s `case 'error': break`).
    if (event.type === 'error' && this.listenerCount('error') === 0) return
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
