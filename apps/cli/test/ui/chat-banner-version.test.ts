/**
 * 启动横幅要显示版本号（"Mipham Code v0.85.46"）与新版本提示。
 *
 * 判据取自 ink 的帧 —— 终端真正收到的那串，而不是源码字符串。
 * 必须挂 `I18nProvider`：没有 Provider 时 `useI18n()` 的 `t` 是恒等函数，
 * 帧里出现的是裸键 `ui.banner.title`，断言会在键名上红；真实运行时用户看到的是译文。
 */

import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { ChatPanel } from '../../src/ui/chat'
import type { ChatMessage } from '../../src/ui/app'
import type { UpdateStatus } from '../../src/shared/update'
import { I18nProvider } from '../../src/i18n-context'
import { createT } from '../../src/i18n-core/t'
import enUS from '../../src/i18n-core/locales/en-US.json'
import type { TranslationMap } from '../../src/i18n-core/types'

const t = createT(enUS as TranslationMap, enUS as TranslationMap)

function bannerFrame(opts: { version?: string; updateStatus?: UpdateStatus | null }): string {
  const { lastFrame, unmount } = render(
    React.createElement(I18nProvider, {
      locale: 'en-US',
      t,
      children: React.createElement(ChatPanel, { messages: [] as ChatMessage[], ...opts }),
    }),
  )
  const frame = lastFrame() ?? ''
  unmount()
  return frame
}

describe('ChatPanel — 启动横幅显示版本号', () => {
  it('标题带上当前版本（"Mipham Code v0.85.46"）', () => {
    expect(bannerFrame({ version: '0.85.46' })).toContain('Mipham Code v0.85.46')
  })

  it('没有 version 时退化为纯标题（对照：不出现悬空的 " v"）', () => {
    const frame = bannerFrame({})
    expect(frame).toContain('Mipham Code')
    expect(frame).not.toContain('Mipham Code v ')
    expect(frame).not.toContain('vundefined')
  })

  it('有新版本时横幅同时给出待升级版本', () => {
    const frame = bannerFrame({
      version: '0.85.46',
      updateStatus: { state: 'available', latest: '0.85.47' },
    })
    expect(frame).toContain('Mipham Code v0.85.46')
    expect(frame).toContain('Update available · v0.85.47')
  })

  it('已装待重启时横幅说明重启生效', () => {
    const frame = bannerFrame({
      version: '0.85.46',
      updateStatus: { state: 'installed', latest: '0.85.46' },
    })
    expect(frame).toContain('Update installed · Restart to apply')
  })
})
