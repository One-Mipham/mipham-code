import React, { useState } from 'react'
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
 * Bottom-of-screen graft status line — mirrors graft's own "◤ graft · …" bar:
 *   ◤ graft · N nodes / E edges · ✓ synced · ~T tok saved
 *   ▸ ctx X% · last: file
 * Reads `graft/.cache/stats.json` (walking up to the repo root) once at mount;
 * the session's tok-saved total is read live each render (the app re-renders on
 * the agent tick). Renders nothing only when there's no graft graph AND no known
 * ctx% — the ctx% line shows even when graft isn't built in this directory.
 */
export function GraftStatusLine({ cwd, ctxPct }: { cwd: string; ctxPct?: number }) {
  const [stats] = useState(() => findGraftStats(cwd))
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
          <Text dimColor>◤ </Text>
          <Text color="blue">graft</Text>
          <Text dimColor>
            {' '}
            · {stats.nodeCount} nodes / {stats.edgeCount} edges ·{' '}
          </Text>
          <Text color={fresh.color}>{fresh.label}</Text>
          {saved > 0 && (
            <>
              <Text dimColor> · </Text>
              <Text color="blue">~{saved.toLocaleString()} tok saved</Text>
            </>
          )}
        </Box>
      )}
      {bottom.length > 0 && (
        <Box>
          <Text dimColor>▸ {bottom.join(' · ')}</Text>
        </Box>
      )}
    </Box>
  )
}
