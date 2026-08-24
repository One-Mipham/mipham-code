import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { readGraftStats, type GraftStats } from '../shared/graft-stats'

/** Freshness segment mirroring graft's own statusline (see @nanonets/graft format.js). */
function freshnessSegment(stats: GraftStats): { label: string; color: string } {
  if (stats.syncing) return { label: 'syncing…', color: 'yellow' }
  if (stats.dirty && stats.staleCount > 0)
    return { label: `⚠ ${stats.staleCount} stale`, color: 'yellow' }
  if (stats.dirty) return { label: '⚠ stale', color: 'yellow' }
  return { label: '✓ synced', color: 'blue' }
}

/**
 * Bottom-of-screen graft status line — mirrors graft's own "◤ graft · N nodes /
 * E edges · ✓ synced" bar. Reads the hook-maintained `graft/.cache/stats.json`
 * once at mount; returns null (renders nothing) when graft isn't built here.
 */
export function GraftStatusLine({ cwd }: { cwd: string }) {
  const [stats] = useState(() => readGraftStats(cwd))
  if (!stats) return null
  const fresh = freshnessSegment(stats)
  return (
    <Box>
      <Text dimColor>◤ </Text>
      <Text color="blue">graft</Text>
      <Text dimColor>
        {' '}
        · {stats.nodeCount} nodes / {stats.edgeCount} edges ·{' '}
      </Text>
      <Text color={fresh.color}>{fresh.label}</Text>
    </Box>
  )
}
