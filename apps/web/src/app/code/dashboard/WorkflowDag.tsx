'use client'

import { useEffect, useRef, useState } from 'react'

interface JournalEntry {
  seq: number
  type: 'agent' | 'phase' | 'log'
  prompt?: string
  opts?: Record<string, unknown>
  message?: string
}

interface WorkflowDagProps {
  entries: JournalEntry[]
  runId: string
}

declare global {
  interface Window {
    mermaid?: {
      initialize: (opts: Record<string, unknown>) => void
      render: (id: string, definition: string) => Promise<{ svg: string }>
    }
  }
}

export function WorkflowDag({ entries, runId }: WorkflowDagProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (entries.length === 0) return

    // Build Mermaid graph definition
    let mermaidDef = 'graph TD\n'

    const phases: Array<{ name: string; agents: Array<{ label: string; seq: number }> }> = []
    let currentPhase: string | null = null

    for (const entry of entries) {
      if (entry.type === 'phase') {
        currentPhase = entry.message || 'default'
        phases.push({ name: currentPhase, agents: [] })
      } else if (entry.type === 'agent' && currentPhase) {
        const phase = phases[phases.length - 1]
        if (phase) {
          const label = (entry.opts?.label as string) || entry.prompt?.slice(0, 30) || 'agent'
          phase.agents.push({ label: label.replace(/[^a-zA-Z0-9]/g, '_'), seq: entry.seq })
        }
      }
    }

    // Render subgraphs for each phase
    let prevPhaseEnd: string | null = null
    for (const phase of phases) {
      if (phase.agents.length === 0) continue

      const phaseId = phase.name.replace(/[^a-zA-Z0-9]/g, '_')
      mermaidDef += `  subgraph ${phaseId}["${phase.name}"]\n`

      for (const agent of phase.agents) {
        const nodeId = `${phaseId}_${agent.label}`
        mermaidDef += `    ${nodeId}["${agent.label} ✓"]\n`
      }

      mermaidDef += '  end\n'

      // Connect phases
      if (prevPhaseEnd && phase.agents.length > 0) {
        const firstNode = `${phaseId}_${phase.agents[0]!.label}`
        mermaidDef += `  ${prevPhaseEnd} --> ${firstNode}\n`
      }

      // Chain agents within phase
      for (let i = 1; i < phase.agents.length; i++) {
        const prev = `${phaseId}_${phase.agents[i - 1]!.label}`
        const curr = `${phaseId}_${phase.agents[i]!.label}`
        mermaidDef += `  ${prev} --> ${curr}\n`
      }

      if (phase.agents.length > 0) {
        prevPhaseEnd = `${phaseId}_${phase.agents[phase.agents.length - 1]!.label}`
      }
    }

    // Render using Mermaid
    const loadMermaid = async () => {
      try {
        if (!window.mermaid) {
          const script = document.createElement('script')
          script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'
          script.async = true
          await new Promise<void>((resolve, reject) => {
            script.onload = () => resolve()
            script.onerror = () => reject(new Error('Failed to load Mermaid'))
            document.head.appendChild(script)
          })
          window.mermaid!.initialize({ startOnLoad: false, theme: 'default' })
        }

        if (containerRef.current) {
          const { svg } = await window.mermaid!.render(`dag-${runId.slice(0, 8)}`, mermaidDef)
          containerRef.current.innerHTML = svg
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to render DAG')
      }
    }

    loadMermaid()
  }, [entries, runId])

  if (error) {
    return <div className="text-red-500 p-4">DAG render error: {error}</div>
  }

  return <div ref={containerRef} className="w-full overflow-x-auto" />
}
