import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const WORKFLOW_DIR = join(homedir(), '.mipham', 'workflows');

function listRuns(): string[] {
  if (!existsSync(WORKFLOW_DIR)) return [];
  return readdirSync(WORKFLOW_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function loadJournal(
  runId: string,
): Array<{ seq: number; type: string }> {
  const path = join(WORKFLOW_DIR, runId, 'journal.jsonl');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { seq: number; type: string });
}

export async function GET(): Promise<NextResponse> {
  try {
    const runs = listRuns();
    const data = runs
      .sort()
      .reverse()
      .slice(0, 20)
      .map((id) => {
        const entries = loadJournal(id);
        return {
          id,
          agentCount: entries.filter((e) => e.type === 'agent').length,
          phaseCount: entries.filter((e) => e.type === 'phase').length,
          logCount: entries.filter((e) => e.type === 'log').length,
        };
      });

    return NextResponse.json({ runs: data, total: runs.length });
  } catch {
    return NextResponse.json(
      { error: 'Failed to read workflow data' },
      { status: 500 },
    );
  }
}
