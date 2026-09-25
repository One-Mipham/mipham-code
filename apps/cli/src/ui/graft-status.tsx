import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { basename } from 'node:path'
import { findGraftStats, type GraftStats } from '../shared/graft-stats'
import { getGraftSavings } from '../shared/graft-savings'

/** Freshness segment mirroring graft's own statusline (see @nanonets/graft format.js). */
function freshnessSegment(stats: GraftStats): { label: string; color: string } {
  if (stats.syncing) return { label: 'syncing…', color: 'yellow' }
  if (stats.dirty && stats.staleCount > 0)
    return { label: `⚠ ${stats.staleCount} stale`, color: 'yellow' }
  if (stats.dirty) return { label: '⚠ stale', color: 'yellow' }
  return { label: '✓ synced', color: 'blue' }
}

/**
 * 只有**真变了**才换 state —— 否则每秒一次 setState 会把整棵树重渲染一遍。
 * 两侧都出自 `findGraftStats` 的同一个 return 字面量，键序恒等，故字符串比较是稳的；
 * 用整体比较而不是逐字段比，是为了将来给 `GraftStats` 加字段时**不必回来补这一行**。
 */
function sameStats(a: GraftStats | null, b: GraftStats | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 重读间隔。与 `goal-progress` / `workflow-progress` 同法（那两处也是 1s 一拍）。 */
const STATS_REFRESH_MS = 1000

/**
 * Bottom-of-screen graft status line — mirrors graft's own "◤ graft · …" bar:
 *   ◤ graft · N nodes / E edges · ✓ synced · ~T tok saved
 *   ▸ ctx X% · last: file
 *
 * `graft/.cache/stats.json`（向上走到仓库根）是**别人在后台写的**：graft 自己重建索引时
 * 先落 `syncing: true`，建完再落回来。挂载时读一次就永远说那一拍的话 ⇒ 启动正好撞上索引
 * 重建的话，页脚会一直挂着 `syncing…`，而磁盘上早已 `"syncing": false` ——「有人的读数与
 * 没人读的那个对象不一致」。故这里**按拍重读**。
 *
 * 别把它降成「每次渲染读一遍」：那要靠别的组件把这一棵带着重渲染（敲键盘 / agent tick）
 * 才生效，而索引建完的那一刻**恰恰可能一个键都没有** —— 页脚会一直撒谎到用户下次敲键。
 *
 * 其余同前：tok-saved 每次渲染实时读；只在有 graft 图或有已知 ctx% 时渲染 —— ctx% 行
 * 在本目录没建过 graft 时也照常显示。
 */
export function GraftStatusLine({ cwd, ctxPct }: { cwd: string; ctxPct?: number }) {
  const [stats, setStats] = useState(() => findGraftStats(cwd))

  useEffect(() => {
    const timer = setInterval(() => {
      const next = findGraftStats(cwd)
      setStats((prev) => (sameStats(prev, next) ? prev : next))
    }, STATS_REFRESH_MS)
    return () => clearInterval(timer)
  }, [cwd])
  const showCtx = typeof ctxPct === 'number'
  if (!stats && !showCtx) return null
  const fresh = stats ? freshnessSegment(stats) : null
  const saved = getGraftSavings()
  const lastFile = stats?.lastFile ? basename(stats.lastFile) : null

  const bottom: string[] = []
  if (typeof ctxPct === 'number') bottom.push(`ctx ${ctxPct}%`)
  if (lastFile) bottom.push(`last: ${lastFile}`)

  return (
    <Box flexDirection="column">
      {stats && fresh && (
        <Box>
          <Text>◤ </Text>
          <Text color="blue">graft</Text>
          <Text>
            {' '}
            · {stats.nodeCount} nodes / {stats.edgeCount} edges ·{' '}
          </Text>
          <Text color={fresh.color}>{fresh.label}</Text>
          {saved > 0 && (
            <>
              <Text> · </Text>
              <Text color="blue">~{saved.toLocaleString()} tok saved</Text>
            </>
          )}
        </Box>
      )}
      {bottom.length > 0 && (
        <Box>
          <Text>▸ {bottom.join(' · ')}</Text>
        </Box>
      )}
    </Box>
  )
}
