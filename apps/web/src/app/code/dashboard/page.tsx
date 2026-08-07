'use client'

import { useState, useEffect } from 'react'
import { useI18n } from '@/i18n/context'
import { WorkflowDag } from './WorkflowDag'

interface RunSummary {
  id: string
  agentCount: number
  phaseCount: number
  logCount: number
}

interface JournalEntry {
  seq: number
  type: 'agent' | 'phase' | 'log'
  prompt?: string
  opts?: Record<string, unknown>
  message?: string
}

interface RunDetail {
  id: string
  script: string
  entries: JournalEntry[]
}

export default function DashboardPage() {
  const { t } = useI18n()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/workflows')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error)
        else setRuns(data.runs || [])
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const loadRun = async (id: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/workflows?id=${encodeURIComponent(id)}`)
      const data = await res.json()
      if (data.error) setError(data.error)
      else setSelectedRun(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-6xl mx-auto py-8 px-6">
      <h1 className="text-3xl font-bold mb-8">{t('web.dashboard.title')}</h1>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      {/* Workflow Runs List */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Workflow Runs</h2>
        {loading && !selectedRun && <p className="text-gray-500">Loading...</p>}
        {!loading && runs.length === 0 && (
          <div className="p-8 bg-gray-50 rounded-xl text-center text-gray-500">
            <p className="text-lg">No workflow runs yet</p>
            <p className="text-sm mt-2">
              Workflow runs appear here after using the Workflow tool in Mipham Code CLI.
            </p>
          </div>
        )}
        <div className="space-y-2">
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => loadRun(run.id)}
              className={`w-full text-left p-4 rounded-lg border transition-colors ${
                selectedRun?.id === run.id
                  ? 'border-mipham-500 bg-mipham-50'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div className="flex justify-between items-center">
                <span className="font-mono text-sm">{run.id.slice(0, 24)}...</span>
                <span className="text-sm text-gray-500">
                  {run.agentCount} agents · {run.phaseCount} phases
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* DAG View */}
      {selectedRun && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">DAG: {selectedRun.id.slice(0, 20)}...</h2>
          <div className="bg-white rounded-xl border border-gray-200 p-6 overflow-x-auto">
            <WorkflowDag entries={selectedRun.entries} runId={selectedRun.id} />
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid md:grid-cols-3 gap-6">
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <div className="text-2xl font-bold text-mipham-600">{runs.length}</div>
          <div className="text-sm text-gray-500 mt-1">Total runs</div>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <div className="text-2xl font-bold text-mipham-600">
            {runs.reduce((sum, r) => sum + r.agentCount, 0)}
          </div>
          <div className="text-sm text-gray-500 mt-1">Total agents executed</div>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <div className="text-2xl font-bold text-mipham-600">
            {runs.length > 0
              ? Math.round(runs.reduce((sum, r) => sum + r.agentCount, 0) / runs.length)
              : 0}
          </div>
          <div className="text-sm text-gray-500 mt-1">Avg agents per run</div>
        </div>
      </div>
    </div>
  )
}
