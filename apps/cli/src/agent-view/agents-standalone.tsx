/**
 * `mipham agents` 独立面板 —— 从 `index.tsx` 里抽出来的那段 JSX，好让它可测。
 *
 * 抽取的理由是**可测性**：`index.tsx` 是进程入口（`render` + `waitUntilExit`），
 * 它里面传下去的东西在测试里够不着；而这条路上的 Enter 落点曾经整个缺席
 * —— 页脚广告 attach，落点是 `() => {}`。
 */

import React, { useState } from 'react'

import { AgentSessionView } from './session-view'
import { AgentViewDashboard } from './dashboard'
import type { AgentViewManager } from './agent-view-manager'

interface AgentsStandaloneProps {
  manager: AgentViewManager
  onExit: () => void
}

export function AgentsStandalone({ manager, onExit }: AgentsStandaloneProps) {
  // 与 `app.tsx` 同形：attach 把会话交给只读视图，视图里的 Esc 再交还列表。
  // 页脚无条件印着「Enter attach」—— 它必须有个落点，否则按键有反应而世界不变。
  const [attachedSessionId, setAttachedSessionId] = useState<string | null>(null)

  if (attachedSessionId) {
    return (
      <AgentSessionView
        manager={manager}
        sessionId={attachedSessionId}
        onDetach={() => setAttachedSessionId(null)}
      />
    )
  }

  return (
    <AgentViewDashboard
      manager={manager}
      onAttach={(session) => setAttachedSessionId(session.id)}
      onExit={onExit}
    />
  )
}
