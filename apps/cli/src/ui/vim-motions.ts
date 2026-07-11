export type VimMode = 'insert' | 'normal'

export class VimMotionEngine {
  mode: VimMode = 'insert'
  private clipboard = ''
  private undoStack: string[] = []
  private redoStack: string[] = []
  private history: string[] = []
  private historyIdx = -1

  /** Handle a keypress in normal mode. Returns new cursor position delta and any text mutation. */
  handleNormal(key: string, text: string, cursor: number): VimAction | null {
    switch (key) {
      case 'h':
        return { cursor: cursor - 1 }
      case 'l':
        return { cursor: cursor + 1 }
      case '0':
        return { cursor: 0 }
      case '$':
        return { cursor: text.length }
      case 'w':
        return { cursor: this.nextWord(text, cursor) }
      case 'b':
        return { cursor: this.prevWord(text, cursor) }
      case 'd':
        return { pending: 'd' }
      case 'y':
        return { pending: 'y' }
      default:
        return null
    }
  }

  /** Handle dd — delete entire line */
  handleDD(text: string): VimAction {
    this.clipboard = text
    this.pushUndo(text)
    return { text: '', cursor: 0 }
  }

  /** Handle yy — yank entire line */
  handleYY(text: string): VimAction {
    this.clipboard = text
    return { cursor: 0 } // no change
  }

  /** Handle p — paste after cursor */
  handlePaste(text: string, cursor: number): VimAction {
    const newText = text.slice(0, cursor) + this.clipboard + text.slice(cursor)
    this.pushUndo(text)
    return { text: newText, cursor: cursor + this.clipboard.length }
  }

  /** Handle u — undo */
  handleUndo(text: string): VimAction {
    const prev = this.undoStack.pop()
    if (prev !== undefined) {
      this.redoStack.push(text)
      return { text: prev, cursor: prev.length }
    }
    return { cursor: text.length }
  }

  /** Handle /search */
  handleSearch(text: string, query: string): VimAction {
    const idx = text.indexOf(query)
    return idx >= 0 ? { cursor: idx } : { cursor: 0 }
  }

  /** Repeat last f/F/t/T motion */
  handleRepeat(text: string, lastFind: string, cursor: number): VimAction {
    const idx = text.indexOf(lastFind, cursor + 1)
    return idx >= 0 ? { cursor: idx } : { cursor }
  }

  private nextWord(text: string, cursor: number): number {
    // Skip word characters, then skip whitespace
    let i = cursor
    while (i < text.length && text[i] !== ' ') i++
    while (i < text.length && text[i] === ' ') i++
    return i
  }

  private prevWord(text: string, cursor: number): number {
    let i = cursor - 1
    while (i > 0 && text[i] === ' ') i--
    while (i > 0 && text[i] !== ' ') i--
    return i > 0 ? i + 1 : 0
  }

  private pushUndo(text: string): void {
    this.undoStack.push(text)
    if (this.undoStack.length > 50) this.undoStack.shift()
  }
}

export interface VimAction {
  text?: string
  cursor?: number
  pending?: string
}
