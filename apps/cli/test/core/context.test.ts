import { describe, it, expect } from 'vitest'
import type { Message, ContentBlock } from '@mipham/shared'
import { ContextManager } from '../../src/core/context'
import { SessionLog, deriveMessages, setAssertModelVisibleDebug } from '../../src/core/session-log'

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
  // Compaction — 二次压缩（触发尺与削减尺不是同一把）
  // ═══════════════════════════════════════════

  it('压完仍超预算时再压一趟，且压得更狠（keep 20 → 10）', async () => {
    // 阈值 = 100 × 0.9 = 90；每条 20 字符 = 5 token
    const ctx = makeContext(100, 0.9)
    ctx.setSystemPrompt('sys')
    for (let i = 0; i < 35; i++) ctx.addMessage(makeTextMessage('user', `msg ${i}`.padEnd(20, '.')))

    expect(ctx.needsCompaction()).toBe(true)
    await ctx.compact('summary')

    const msgs = ctx.getMessages()
    // 第一趟 35 → 20 后仍是 101 token > 90 ⇒ 第二趟 20 → 10
    expect(msgs).toHaveLength(10)
    expect(msgs[0]!.content as string).toMatch(/^msg 25/)
    expect(msgs[9]!.content as string).toMatch(/^msg 34/)
    expect(ctx.needsCompaction()).toBe(false)
  })

  it('一趟就够时不多跑第二趟 —— 复查不是「无条件再压一次」', async () => {
    // 阈值 = 1000 × 0.9 = 900；35 条 × 5 token = 175，第一趟后远低于阈值
    const ctx = makeContext(1000, 0.9)
    ctx.setSystemPrompt('sys')
    for (let i = 0; i < 35; i++) ctx.addMessage(makeTextMessage('user', `msg ${i}`.padEnd(20, '.')))

    await ctx.compact('summary')

    // 第二趟若无条件跑，这里会是 10
    expect(ctx.getMessages()).toHaveLength(20)
  })

  it('两趟都压不动时停下（有界，不死循环）—— 单条超大消息削不掉是诚实的边界', async () => {
    // 阈值 90；每条 40 字符 = 10 token
    const ctx = makeContext(100, 0.9)
    ctx.setSystemPrompt('sys')
    for (let i = 0; i < 35; i++) ctx.addMessage(makeTextMessage('user', `msg ${i}`.padEnd(40, '.')))

    await ctx.compact('summary') // 调度表只有两趟 ⇒ 必然返回

    expect(ctx.getMessages()).toHaveLength(10)
    // 仍是超预算 —— 条数已削到底，再往下要的是 tool_result 级截断（本轮不做）
    expect(ctx.needsCompaction()).toBe(true)
  })

  it('超预算的短会话也会被压：≤30 条不再等于「什么都不做」', async () => {
    // 这条钉的是**有意的行为变化**。旧实现对 ≤30 条直接 no-op，**即便它已超 token 预算** ——
    // 而那种会话正是「判着要压、却压不动」这个缺口本身，不是它之外的例外。
    const over = makeContext(100, 0.9) // 阈值 90；25 条 × 10 token = 250
    over.setSystemPrompt('sys')
    for (let i = 0; i < 25; i++)
      over.addMessage(makeTextMessage('user', `msg ${i}`.padEnd(40, '.')))
    await over.compact('summary')
    expect(over.getMessages()).toHaveLength(10)

    // 正对照：同样 25 条、预算充裕 ⇒ 一条都不动。
    // 没有这一半，上面那半在「守卫被整个删掉」时也会绿。
    const roomy = makeContext(200_000, 0.9)
    roomy.setSystemPrompt('sys')
    for (let i = 0; i < 25; i++) roomy.addMessage(makeTextMessage('user', 'msg'))
    await roomy.compact('summary')
    expect(roomy.getMessages()).toHaveLength(25)
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

  it('回退落成日志事件 —— 从日志重投影不会让被回退的那一轮回来', () => {
    const ctx = makeContext()
    const log = new SessionLog('rewind-regression')
    ctx.setLog(log)

    ctx.addMessage(makeTextMessage('user', 'msg1'))
    ctx.addMessage(makeTextMessage('assistant', 'reply1'))
    ctx.saveCheckpoint('after-msg1')
    ctx.addMessage(makeTextMessage('user', 'msg2'))
    ctx.addMessage(makeTextMessage('assistant', 'reply2'))

    ctx.restoreCheckpoint()

    // 内存里的投影立刻是对的
    expect(ctx.getMessages()).toHaveLength(2)

    // 关键的另一半：`--resume` / `/resume` 是从日志**重投影**的。不落事件时这里会拿回
    // 4 条 —— 用户回退了，下次恢复那一轮又原样回来（而且屏幕上还看不见它回来了）。
    expect(log.events().some((e) => e.type === 'rewind')).toBe(true)
    expect(deriveMessages(log.events())).toEqual(ctx.getMessages())
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

  // ═══════════════════════════════════════════
  // updateMaxTokens / getMaxTokens
  // ═══════════════════════════════════════════

  it('should update max tokens dynamically', () => {
    const ctx = makeContext(100_000)
    expect(ctx.getMaxTokens()).toBe(100_000)

    ctx.updateMaxTokens(500_000)
    expect(ctx.getMaxTokens()).toBe(500_000)
  })

  it('should update max tokens to 1M for large context windows', () => {
    const ctx = makeContext(200_000)
    expect(ctx.getMaxTokens()).toBe(200_000)

    ctx.updateMaxTokens(1_000_000)
    expect(ctx.getMaxTokens()).toBe(1_000_000)
  })

  it('should respect compaction threshold after max tokens update', () => {
    const ctx = makeContext(200_000, 0.9)
    // At 200K tokens max, threshold = 180K → won't compact with small content
    ctx.setSystemPrompt('small prompt')
    expect(ctx.needsCompaction()).toBe(false)

    // Update to a tiny max — should now need compaction
    ctx.updateMaxTokens(10)
    // threshold = 9 tokens, 'small prompt' = 12 chars → ceil(12/4) = 3 → still under
    // But needsCompaction checks >, not >=, so 3 > 9 is false
    ctx.setSystemPrompt('larger prompt content here') // ~28 chars → 7 tokens, > 9? no
    // Use a really large prompt to trigger
    ctx.setSystemPrompt('A'.repeat(1000)) // 250 tokens > 9 threshold → true
    expect(ctx.needsCompaction()).toBe(true)

    // Restore to large max
    ctx.updateMaxTokens(1_000_000)
    expect(ctx.needsCompaction()).toBe(false)
  })
})

describe('ContextManager log integration', () => {
  it('addMessage appends events to an attached log', () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    const log = new SessionLog('cm-test')
    cm.setLog(log)
    cm.addMessage({ role: 'user', content: 'hi' })
    cm.addMessage({ role: 'assistant', content: 'hello' })
    expect(deriveMessages(log.events())).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('behaves unchanged when no log is attached', () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    cm.addMessage({ role: 'user', content: 'hi' })
    expect(cm.getMessages()).toEqual([{ role: 'user', content: 'hi' }])
    expect(cm.getLog()).toBeUndefined()
  })

  it('restoreLog sets log as source without re-appending', () => {
    const log = new SessionLog('restore-test')
    log.append({ type: 'session/start', at: 1, sessionId: 'restore-test' })
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: 'hi' } })
    log.append({ type: 'assistant/message', at: 1, message: { role: 'assistant', content: 'yo' } })

    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    cm.restoreLog(log)
    expect(cm.getMessages()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ])
    expect(deriveMessages(cm.getLog()!.events())).toHaveLength(2) // 未重复写通
  })

  // `index.tsx:584-585` 就是**这个顺序**：先 `restoreLog`（含消息的完整估值），
  // 后 `setSystemPrompt`。若后者只按系统提示重算，`--resume` 一进去估值就偏低 ⇒
  // `needsCompaction()` 长期偏 false ⇒ 压缩迟触发（context 越滚越大才动手）。
  it('restoreLog 之后 setSystemPrompt 不把含消息的估值覆盖成偏低值', () => {
    const big = 'x'.repeat(4000)
    const log = new SessionLog('resume-estimate-test')
    log.append({ type: 'session/start', at: 1, sessionId: 'resume-estimate-test' })
    log.append({ type: 'user/message', at: 1, message: { role: 'user', content: big } })

    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    cm.restoreLog(log)
    cm.setSystemPrompt('sys')

    // 对照：同一句系统提示、**没有消息**。恢复出来的估值必须**大于**它 —— 多出来的
    // 就是那条消息。改成「只算提示」的实现会让两个数相等，判据随之变红。
    const bare = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    bare.setSystemPrompt('sys')
    expect(cm.getEstimatedTokens()).toBeGreaterThan(bare.getEstimatedTokens())

    // 再设一次同样的提示：估值不许变（幂等 —— 顺手挡住「每次设都叠一遍」那种错法）。
    const first = cm.getEstimatedTokens()
    cm.setSystemPrompt('sys')
    expect(cm.getEstimatedTokens()).toBe(first)
  })

  it('addMessage does not throw when invariant holds (debug on)', () => {
    setAssertModelVisibleDebug(true)
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    const log = new SessionLog('assert-debug-test')
    cm.setLog(log)
    expect(() => {
      cm.addMessage({ role: 'user', content: 'hi' })
      cm.addMessage({ role: 'assistant', content: 'hello' })
    }).not.toThrow()
  })

  it('throws when messages diverge from log (debug on)', () => {
    setAssertModelVisibleDebug(true)
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    const log = new SessionLog('assert-debug-throw-test')
    cm.setLog(log)
    cm.addMessage({ role: 'user', content: 'logged' })
    cm.replaceMessages([{ role: 'user', content: 'NOT-LOGGED' }]) // 绕过日志写通
    expect(() => cm.addMessage({ role: 'user', content: 'trigger' })).toThrow(/not logged/)
  })

  it('compact records replacedCount and deriveMessages reproduces post-compaction projection', async () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    const log = new SessionLog('compact-position-test')
    cm.setLog(log)
    cm.setSummarizer(async () => 'summarized content')
    for (let i = 0; i < 31; i++) {
      cm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` })
    }
    await cm.compact('test')
    const derived = deriveMessages(log.events())
    expect(derived[0]).toEqual({
      role: 'user',
      content: '[Earlier conversation summary]: summarized content',
    })
    expect(derived).toHaveLength(21) // 1 摘要 + 20 保留
  })

  it('addToolResult records full result and derives projection', () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    const log = new SessionLog('tool-result-test')
    cm.setLog(log)
    cm.addToolResult('t1', { success: false, content: 'partial', error: 'boom' })
    expect(cm.getMessages()).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
      },
    ])
    const raw = log.events().find((e) => e.type === 'tool/result')
    expect(raw).toMatchObject({ id: 't1', result: { success: false, error: 'boom' } })
  })

  it('addToolResult leaves the projection of a successful tool without is_error', () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    cm.addToolResult('t1', { success: true, content: 'ok' })
    const block = (cm.getMessages()[0]!.content as unknown as Array<Record<string, unknown>>)[0]!
    expect('is_error' in block).toBe(false)
  })

  it('addToolResult projection round-trips through the session log', () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    const log = new SessionLog('tool-result-roundtrip')
    cm.setLog(log)
    cm.addToolResult('t1', { success: false, content: 'partial', error: 'boom' })
    expect(deriveMessages(log.events())).toEqual(cm.getMessages())
  })

  it('recordChunk appends chunks to log but not to projection', () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    const log = new SessionLog('chunk-ctx-test')
    cm.setLog(log)
    cm.recordChunk('Hel')
    cm.recordChunk('lo')
    expect(cm.getMessages()).toEqual([])
    expect(log.events().filter((e) => e.type === 'assistant/chunk')).toHaveLength(2)
  })

  it('compact derives replacedCount from the log, not the drifted projection', async () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    const log = new SessionLog('compact-drift-test')
    cm.setLog(log)
    cm.setSummarizer(async () => 'S')
    for (let i = 0; i < 40; i++) {
      cm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` })
    }
    cm.replaceMessages(cm.getMessages().slice(8)) // 投影缩短至 32，日志仍 40
    await cm.compact('test')
    const ev = log.events().find((e) => e.type === 'compaction/summary') as {
      replacedCount: number
    }
    expect(ev.replacedCount).toBe(40 - 20) // 20（取自日志 40），而非 toDrop.length=12
  })

  it('runMicrocompact appends compaction/rewrite and deriveMessages reproduces the projection', async () => {
    const cm = new ContextManager({ maxTokens: 60, compactionThreshold: 0.9 })
    const log = new SessionLog('microcompact-rewrite-test')
    cm.setLog(log)
    // 4 个非空 tool_result → microcompact keepRecent=3 会把最旧的 t0 换成占位符
    for (let i = 0; i < 4; i++) {
      cm.addToolResult(`t${i}`, { success: true, content: `result content ${i} with some length` })
    }
    await new Promise((resolve) => setTimeout(resolve, 0)) // flush 异步 microcompact
    const rewrite = log.events().find((e) => e.type === 'compaction/rewrite')
    expect(rewrite).toBeDefined()
    expect(deriveMessages(log.events())).toEqual(cm.getMessages())
    expect(cm.getMessages()[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't0', content: '[earlier result omitted]' }],
    })
  })

  it('compact truncation fallback (no summarizer) appends compaction/rewrite', async () => {
    const cm = new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9 })
    const log = new SessionLog('compact-truncate-rewrite-test')
    cm.setLog(log)
    // 无 summarizer：compact 走纯截断分支
    for (let i = 0; i < 31; i++) {
      cm.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` })
    }
    await cm.compact('test')
    expect(deriveMessages(log.events())).toEqual(cm.getMessages())
    expect(cm.getMessages()).toHaveLength(20) // 纯截断保留最后 20 条
    expect(log.events().some((e) => e.type === 'compaction/rewrite')).toBe(true)
  })

  // ═══════════════════════════════════════════
  // 读时派生的段（权限 / MCP instructions）必须进估值
  // ═══════════════════════════════════════════
  //
  // 系统提示里有两段是**读时派生**的：权限段接 `PermissionSystem.getMode()`，MCP 段接已连
  // server 的 instructions。它们的施加点是 `index.tsx` 接上去的 live 闭包，**变点不在
  // ContextManager 里** —— MCP server 是启动后异步连上（`index.tsx:686` 在任何一次
  // `setSystemPrompt` 之后），权限档是 Shift+Tab 随时切。
  //
  // 所以「想清楚在哪几个变点重算一次」这条路走不通：调用方枚举不出变点全集，漏一个，
  // 估值就长期偏低 ⇒ `needsCompaction()` 长期偏 false ⇒ 压缩迟触发（上下文滚到很大才动手）。
  // 这组用例钉的是**派生**：读数跟着闭包的返回值走，而不是跟着「谁调了哪个 setter」走。
  describe('读时派生的段计入估值', () => {
    it('MCP instructions 段接上之后立刻计入估值（不需要任何一次重算调用）', () => {
      const ctx = makeContext()
      ctx.setSystemPrompt('sys')
      const before = ctx.getEstimatedTokens()

      ctx.setMcpInstructionsSource(() => 'M'.repeat(4000)) // 拉丁 4000 字符 → 1000 tokens

      // 段本身 1000 tokens，外加拼接的 `\n\n---\n\n` 分隔符（7 字符 → 2 tokens）。
      expect(ctx.getEstimatedTokens() - before).toBeGreaterThan(1000)
      expect(ctx.getEstimatedTokens() - before).toBeLessThan(1010)
    })

    it('权限段同理（同一个缺陷的第二个成员）', () => {
      const ctx = makeContext()
      ctx.setSystemPrompt('sys')
      const before = ctx.getEstimatedTokens()

      ctx.setPermissionContextSource(() => 'P'.repeat(4000))

      expect(ctx.getEstimatedTokens() - before).toBeGreaterThan(1000)
    })

    it('闭包换了返回值，下一次读数就跟着变（是派生，不是接上时算一次）', () => {
      let block = ''
      const ctx = makeContext()
      ctx.setSystemPrompt('sys')
      ctx.setMcpInstructionsSource(() => block)
      const atEmpty = ctx.getEstimatedTokens()

      block = 'M'.repeat(4000)
      expect(ctx.getEstimatedTokens()).toBeGreaterThan(atEmpty)

      // 反向：server 断了 / instructions 被清掉，也要跟着降回去 —— 只涨不跌同样是
      // 「记了一份拷贝」，只不过拷贝的是最大值。
      block = ''
      expect(ctx.getEstimatedTokens()).toBe(atEmpty)
    })

    it('段真能把会话推过压缩线（这才是这个数存在的理由）', () => {
      const ctx = makeContext(300, 0.9) // 阈值 270 tokens
      ctx.setSystemPrompt('A'.repeat(100)) // 25 tokens
      expect(ctx.needsCompaction()).toBe(false)

      ctx.setMcpInstructionsSource(() => 'M'.repeat(4000)) // +1000 tokens

      expect(ctx.needsCompaction()).toBe(true)
    })

    it('负控：源返回空串不产生空段，估值一个 token 都不变', () => {
      const ctx = makeContext()
      ctx.setSystemPrompt('sys')
      const before = ctx.getEstimatedTokens()

      ctx.setMcpInstructionsSource(() => '')
      ctx.setPermissionContextSource(() => '')

      expect(ctx.getEstimatedTokens()).toBe(before)
    })
  })
})
