import { MemoryManager } from './memory-manager'
import type { MemoryManager as MemoryManagerType } from './memory-manager'

const MEMORY_DIR = `${process.env.HOME || '~'}/.mipham/memory`

let instance: MemoryManagerType | null = null

export function getMemoryManager(): MemoryManagerType {
  if (!instance) {
    instance = new MemoryManager(MEMORY_DIR)
    instance.loadAll()
  }
  return instance
}

/**
 * Load relevant memories for the current session and inject as
 * a system-reminder block. Called at SessionStart.
 */
export function loadSessionMemories(context: string): string {
  const mm = getMemoryManager()
  return mm.buildSystemReminder(context)
}
