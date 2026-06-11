import { describe, it, expect } from 'vitest'
import type { Message, ContentBlock } from '@mipham/shared'
import { ContextManager } from '../../src/core/context'

function makeContext(maxTokens = 200_000, compactionThreshold = 0.9) {
  return new ContextManager({ maxTokens, compactionThreshold })
}

function makeTextMessage(role: Message['role'], text: string): Message {
  return { role, content: text }
}

function makeBlockMessage(role: Message['role'], blocks: ContentBlock[]): Message {
  return { role, content: blocks }
}

// ── Tests ──

describe('ContextManager', () => {
  // ═══════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════

  it('should set and get system prompt', () => {
    const ctx = makeContext()
    ctx.setSystemPrompt('You are a helpful assistant.')
    expect(ctx.getSystemPrompt()).toBe('You are a helpful assistant.')
  })

  it('should estimate tokens from system prompt on set', () => {
    const ctx = makeContext()
    // 28 chars → ceil(28/4) = 7 tokens
    ctx.setSystemPrompt('You are a helpful assistant.')
    expect(ctx.getEstimatedTokens()).toBe(7)
  })

  it('should start with empty system prompt', () => {
    const ctx = makeContext()
    expect(ctx.getSystemPrompt()).toBe('')
  })

  // ═══════════════════════════════════════════
  // Messages
  // ═══════════════════════════════════════════

  it('should add and retrieve messages', () => {
    const ctx = makeContext()
    ctx.addMessage(makeTextMessage('user', 'hello'))
    ctx.addMessage(makeTextMessage('assistant', 'hi there'))

    const msgs = ctx.getMessages()
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[1]!.role).toBe('assistant')
  })

  it('should return a copy of messages (immutable)', () => {
    const ctx = makeContext()
    ctx.addMessage(makeTextMessage('user', 'hello'))

    const msgs = ctx.getMessages()
    msgs.push(makeTextMessage('user', 'extra'))

    expect(ctx.getMessages()).toHaveLength(1)
  })

  it('should track token count for string messages', () => {
    const ctx = makeContext()
    // 'hello' = 5 chars → ceil(5/4) = 2 tokens
    ctx.addMessage(makeTextMessage('user', 'hello'))
    expect(ctx.getEstimatedTokens()).toBe(2)
  })

  it('should track token count for ContentBlock[] messages via JSON', () => {
    const ctx = makeContext()
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'describe this image' },
      { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
    ]
    // Actual JSON.stringify output length → ceil(len/4)
    const jsonLen = JSON.stringify(blocks).length
    const expected = Math.ceil(jsonLen / 4)
    ctx.addMessage(makeBlockMessage('user', blocks))

    const tokens = ctx.getEstimatedTokens()
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBe(expected)
  })

  // ═══════════════════════════════════════════
  // Compaction detection
  // ═══════════════════════════════════════════

  it('should not need compaction when under threshold', () => {
    const ctx = makeContext(1000, 0.9)
    ctx.setSystemPrompt('short') // 5 chars → 2 tokens
    // threshold = 900, estimated = 2
    expect(ctx.needsCompaction()).toBe(false)
  })

  it('should need compaction when over threshold', () => {
    const ctx = makeContext(100, 0.5)
    // threshold = 50
    ctx.setSystemPrompt('A'.repeat(400)) // 400 chars → 100 tokens
    expect(ctx.needsCompaction()).toBe(true)
  })

  it('should need compaction right at threshold boundary', () => {
    const ctx = makeContext(100, 0.9)
    // threshold = 90
    ctx.setSystemPrompt('A'.repeat(400)) // 100 tokens > 90
    expect(ctx.needsCompaction()).toBe(true)
  })

  it('should not need compaction exactly at threshold', () => {
    const ctx = makeContext(100, 0.9)
    // 360 chars → 90 tokens, threshold = 90, needsCompaction checks > (not >=)
    ctx.setSystemPrompt('A'.repeat(360))
    expect(ctx.needsCompaction()).toBe(false)
  })

  // ═══════════════════════════════════════════
  // Compaction behavior
  // ═══════════════════════════════════════════

  it('should truncate to last 20 messages when >30 messages', async () => {
    const ctx = makeContext()
    ctx.setSystemPrompt('system')

    // Add 35 messages
    for (let i = 0; i < 35; i++) {
      ctx.addMessage(makeTextMessage('user', `msg ${i}`))
    }

    await ctx.compact('summary')

    const msgs = ctx.getMessages()
    expect(msgs).toHaveLength(20)
    // Should keep the LAST 20 (msg 15-34)
    expect(msgs[0]!.content as string).toBe('msg 15')
    expect(msgs[19]!.content as string).toBe('msg 34')
  })

  it('should not truncate when <=30 messages', async () => {
    const ctx = makeContext()
    ctx.setSystemPrompt('system')

    for (let i = 0; i < 25; i++) {
      ctx.addMessage(makeTextMessage('user', `msg ${i}`))
    }

    await ctx.compact('summary')
    expect(ctx.getMessages()).toHaveLength(25)
  })

  it('should re-estimate tokens after compaction', async () => {
    const ctx = makeContext()
    ctx.setSystemPrompt('sys')

    for (let i = 0; i < 35; i++) {
      ctx.addMessage(makeTextMessage('user', 'm')) // 1 char → 1 token each
    }

    await ctx.compact('summary')

    // system: 'sys' → ceil(3/4) = 1 token
    // 20 messages × 1 char each → 20 tokens
    // Total: 21 tokens
    expect(ctx.getEstimatedTokens()).toBe(21)
  })

  // ═══════════════════════════════════════════
  // Clear
  // ═══════════════════════════════════════════

  it('should clear all messages', () => {
    const ctx = makeContext()
    ctx.addMessage(makeTextMessage('user', 'hello'))
    ctx.addMessage(makeTextMessage('assistant', 'world'))

    ctx.clear()
    expect(ctx.getMessages()).toHaveLength(0)
  })

  it('should reset estimated tokens to system prompt only on clear', () => {
    const ctx = makeContext()
    ctx.setSystemPrompt('abcd') // 4 chars → 1 token
    ctx.addMessage(makeTextMessage('user', 'hello world')) // +3 tokens

    ctx.clear()
    expect(ctx.getEstimatedTokens()).toBe(1)
  })

  // ═══════════════════════════════════════════
  // Token estimation edges
  // ═══════════════════════════════════════════

  it('should estimate 0 tokens for empty text', () => {
    const ctx = makeContext()
    ctx.setSystemPrompt('')
    expect(ctx.getEstimatedTokens()).toBe(0)
  })

  it('should accumulate tokens from multiple messages', () => {
    const ctx = makeContext()
    ctx.setSystemPrompt('A'.repeat(100)) // 100 chars → 25 tokens

    ctx.addMessage(makeTextMessage('user', 'B'.repeat(40))) // +10 tokens
    ctx.addMessage(makeTextMessage('assistant', 'C'.repeat(80))) // +20 tokens

    expect(ctx.getEstimatedTokens()).toBe(55)
  })

  // ═══════════════════════════════════════════
  // Checkpoint / Rewind
  // ═══════════════════════════════════════════

  it('should save and list checkpoints', () => {
    const ctx = makeContext()
    ctx.addMessage(makeTextMessage('user', 'hello'))
    ctx.addMessage(makeTextMessage('assistant', 'hi'))

    ctx.saveCheckpoint('test-checkpoint')
    const cps = ctx.getCheckpoints()

    expect(cps).toHaveLength(1)
    expect(cps[0]!.label).toBe('test-checkpoint')
    expect(cps[0]!.messageCount).toBe(2)
  })

  it('should auto-increment checkpoint IDs', () => {
    const ctx = makeContext()
    const id1 = ctx.saveCheckpoint('first')
    const id2 = ctx.saveCheckpoint('second')
    expect(id2).toBeGreaterThan(id1)
  })

  it('should restore to a checkpoint', () => {
    const ctx = makeContext()
    ctx.addMessage(makeTextMessage('user', 'msg1'))
    ctx.addMessage(makeTextMessage('assistant', 'reply1'))
    ctx.saveCheckpoint('after-msg1')

    // Add more messages
    ctx.addMessage(makeTextMessage('user', 'msg2'))
    ctx.addMessage(makeTextMessage('assistant', 'reply2'))

    const result = ctx.restoreCheckpoint()
    expect(result.restored).toBe(true)
    expect(result.messageCount).toBe(2)
    expect(result.label).toBe('after-msg1')

    const msgs = ctx.getMessages()
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.content as string).toBe('msg1')
  })

  it('should restore specific checkpoint by ID', () => {
    const ctx = makeContext()
    ctx.addMessage(makeTextMessage('user', 'msg1'))
    const id1 = ctx.saveCheckpoint('first')

    ctx.addMessage(makeTextMessage('user', 'msg2'))
    ctx.saveCheckpoint('second')

    ctx.addMessage(makeTextMessage('user', 'msg3'))

    // Restore to first checkpoint
    const result = ctx.restoreCheckpoint(id1)
    expect(result.restored).toBe(true)
    expect(result.label).toBe('first')

    const msgs = ctx.getMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content as string).toBe('msg1')
  })

  it('should report failure when no checkpoints exist', () => {
    const ctx = makeContext()
    ctx.addMessage(makeTextMessage('user', 'hello'))

    const result = ctx.restoreCheckpoint()
    expect(result.restored).toBe(false)
    expect(result.messageCount).toBe(1)
  })

  it('should restore tokens alongside messages', () => {
    const ctx = makeContext()
    ctx.setSystemPrompt('sys') // 3 chars → 1 token
    ctx.addMessage(makeTextMessage('user', 'hello')) // 5 chars → 2 tokens

    ctx.saveCheckpoint('token-check')

    ctx.addMessage(makeTextMessage('user', 'additional content here')) // +tokens

    const beforeRestore = ctx.getEstimatedTokens()
    expect(beforeRestore).toBeGreaterThan(3) // > 1+2=3

    ctx.restoreCheckpoint()
    expect(ctx.getEstimatedTokens()).toBe(3) // back to system+original msg
  })

  it('should keep only last 10 checkpoints', () => {
    const ctx = makeContext()
    for (let i = 0; i < 15; i++) {
      ctx.saveCheckpoint(`cp-${i}`)
    }

    const cps = ctx.getCheckpoints()
    expect(cps).toHaveLength(10)
    expect(cps[0]!.label).toBe('cp-5') // first 5 were dropped
    expect(cps[9]!.label).toBe('cp-14')
  })

  it('should deep-clone messages on save and not mutate on restore', () => {
    const ctx = makeContext()
    ctx.addMessage(makeTextMessage('user', 'original'))
    ctx.saveCheckpoint('deep-clone')

    // Modify after checkpoint
    ctx.addMessage(makeTextMessage('user', 'modified'))
    expect(ctx.getMessages()).toHaveLength(2)

    // Restore
    ctx.restoreCheckpoint()
    expect(ctx.getMessages()).toHaveLength(1)
    expect(ctx.getMessages()[0]!.content as string).toBe('original')

    // Save another checkpoint and verify original is still intact
    ctx.saveCheckpoint('after-restore')
    ctx.addMessage(makeTextMessage('user', 'new-msg'))
    ctx.restoreCheckpoint()
    expect(ctx.getMessages()).toHaveLength(1)
    expect(ctx.getMessages()[0]!.content as string).toBe('original')
  })

  it('should clear checkpoints on clear()', () => {
    const ctx = makeContext()
    ctx.addMessage(makeTextMessage('user', 'hello'))
    ctx.saveCheckpoint('pre-clear')
    expect(ctx.getCheckpoints()).toHaveLength(1)

    ctx.clear()
    expect(ctx.getCheckpoints()).toHaveLength(0)
    expect(ctx.getMessages()).toHaveLength(0)
  })

  it('should return getMessageCount', () => {
    const ctx = makeContext()
    expect(ctx.getMessageCount()).toBe(0)
    ctx.addMessage(makeTextMessage('user', 'a'))
    ctx.addMessage(makeTextMessage('assistant', 'b'))
    expect(ctx.getMessageCount()).toBe(2)
  })

  it('should getLastCheckpointId when checkpoints exist', () => {
    const ctx = makeContext()
    expect(ctx.getLastCheckpointId()).toBeUndefined()

    const id = ctx.saveCheckpoint('test')
    expect(ctx.getLastCheckpointId()).toBe(id)
  })
})
