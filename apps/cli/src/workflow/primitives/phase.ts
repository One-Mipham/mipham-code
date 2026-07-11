let currentPhase: string = ''

/**
 * Set the current workflow phase title.
 * In a real implementation, this emits to a progress tracker.
 */
export function phase(title: string): void {
  currentPhase = title
}

/** Get the current workflow phase title. */
export function getCurrentPhase(): string {
  return currentPhase
}

/** Reset the current phase state (useful for testing). */
export function resetPhase(): void {
  currentPhase = ''
}
