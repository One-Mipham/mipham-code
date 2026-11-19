import { describe, it, expect } from 'vitest'
import { runCommandHandler } from '../../src/ui/commands'
import type { CommandContext, CommandHandler } from '../../src/ui/commands'

/**
 * A slash command that throws must answer as that command, not end the session.
 *
 * The failure this pins is concrete: handlers write files (`/permissions` →
 * settings.json, `/export` → the export file), and a write failure used to
 * escape the submit callback as an unhandled rejection. The process-wide crash
 * handler treats that as fatal, so "the settings file is read-only" arrived as
 * an exiting CLI. The wrapper turns the throw into a value the caller prints.
 */

const ctx = {} as CommandContext

describe('runCommandHandler', () => {
  it('成功路径：原样返回 handler 的结果（同步与异步都收口到同一个形状）', async () => {
    const sync: CommandHandler = () => ({ content: 'done' })
    const asyncHandler: CommandHandler = async () => ({ content: 'done later' })

    await expect(runCommandHandler(sync, ctx, [])).resolves.toEqual({
      ok: true,
      result: { content: 'done' },
    })
    await expect(runCommandHandler(asyncHandler, ctx, [])).resolves.toEqual({
      ok: true,
      result: { content: 'done later' },
    })
  })

  it('同步抛出 → ok: false 带原消息，不向外抛', async () => {
    const handler: CommandHandler = () => {
      throw new Error('EACCES: permission denied, open /home/u/.mipham/settings.json')
    }

    const outcome = await runCommandHandler(handler, ctx, [])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('EACCES')
  })

  it('异步拒绝 → 同上（这条是实际踩到的形态：await handler(…) 的拒绝就是它）', async () => {
    const handler: CommandHandler = async () => {
      throw new Error('settings.json is not valid JSON')
    }

    const outcome = await runCommandHandler(handler, ctx, [])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('not valid JSON')
  })

  it('抛出的不是 Error（字符串/对象）也不吞掉，转成文本', async () => {
    const handler = (() => {
      throw 'plain string failure'
    }) as unknown as CommandHandler

    const outcome = await runCommandHandler(handler, ctx, [])
    expect(outcome).toEqual({ ok: false, message: 'plain string failure' })
  })
})
