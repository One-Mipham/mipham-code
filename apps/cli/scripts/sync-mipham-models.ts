#!/usr/bin/env bun
/**
 * Sync Mipham model definitions from Engine → mipham-code.
 *
 * Fetches GET /v1/mipham-models from the Engine API and writes the result
 * to packages/shared/src/mipham-models.json.  This JSON is the single
 * source of truth for MiphamAI provider models in mipham-code.
 *
 * Usage:
 *   bun run scripts/sync-mipham-models.ts [--engine-url <url>]
 *
 *   # Default (production Engine):
 *   bun run scripts/sync-mipham-models.ts
 *
 *   # Custom Engine (staging / local):
 *   bun run scripts/sync-mipham-models.ts --engine-url http://localhost:8080
 *
 * The generated JSON is committed to the repo and serves as the hardcoded
 * fallback when Engine is unreachable at runtime.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const SHARED_DIR = resolve(
  dirname(new URL(import.meta.url).pathname),
  '../../../packages/shared/src',
)
const OUTPUT_FILE = resolve(SHARED_DIR, 'mipham-models.json')

interface EngineModel {
  id: string
  name: string
  providerId: string
  contextWindow: number
  maxOutput: number
  vision: boolean
  capabilities: string[]
  cost: { input_per_1m: number; output_per_1m: number }
  benchmarks: { mmlu: number; human_eval: number; gsm8k: number }
  latency: { avg_ms: number; p95_ms: number }
  priority: number
  tags: string[]
  status: string
}

interface EngineResponse {
  provider: { id: string; name: string; protocol: string }
  models: EngineModel[]
  generated_at: string
  model_count: number
}

interface SyncedModel {
  id: string
  name: string
  providerId: string
  contextWindow: number
  maxOutput: number
  vision: boolean
  status: 'active' | 'upcoming' | 'deprecated'
}

interface SnapshotFile {
  _comment: string
  provider: {
    id: string
    name: string
    protocol: string
    baseUrl: string
    apiKey: string
    status: string
  }
  models: SyncedModel[]
  synced_at: string
}

async function main() {
  const args = process.argv.slice(2)
  let engineUrl = 'https://api.mipham.ai/v1'

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--engine-url' && args[i + 1]) {
      engineUrl = args[++i]
    }
  }

  const endpoint = `${engineUrl}/mipham-models`
  console.log(`🔍 Fetching Mipham models from ${endpoint}...`)

  let data: EngineResponse
  try {
    const resp = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
    }
    data = (await resp.json()) as EngineResponse
  } catch (err) {
    console.error(`❌ Failed to fetch from Engine: ${err}`)
    console.log('📦 Using existing mipham-models.json as fallback.')
    process.exit(1)
  }

  // Transform Engine model format → mipham-code ModelInfo format
  const models: SyncedModel[] = data.models.map((m) => ({
    id: m.id,
    name: m.name,
    providerId: m.providerId,
    contextWindow: m.contextWindow,
    maxOutput: m.maxOutput,
    vision: m.vision,
    status: m.status as 'active' | 'upcoming' | 'deprecated',
  }))

  // Preserve provider config from existing snapshot (baseUrl, apiKey)
  let provider = {
    id: 'mipham',
    name: 'MiphamAI',
    protocol: 'openai-compatible' as const,
    baseUrl: 'https://api.mipham.ai/v1',
    apiKey: '${MIPHAM_API_KEY}',
    status: 'active',
  }
  try {
    const existing: SnapshotFile = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'))
    provider = existing.provider
  } catch {
    // Use defaults
  }

  const snapshot: SnapshotFile = {
    _comment:
      'Mipham model definitions — synced from Engine GET /v1/mipham-models. ' +
      "Run 'bun run scripts/sync-mipham-models.ts' to update.",
    provider,
    models,
    synced_at: new Date().toISOString(),
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(snapshot, null, 2) + '\n')
  console.log(`✅ Synced ${models.length} Mipham models → packages/shared/src/mipham-models.json`)
  console.log(`   Synced at: ${snapshot.synced_at}`)
  for (const m of models) {
    console.log(`   • ${m.id} (ctx=${m.contextWindow.toLocaleString()}, status=${m.status})`)
  }
}

main()
