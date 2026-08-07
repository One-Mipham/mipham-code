import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const dynamic = 'force-static';

const WORKFLOW_DIR = join(homedir(), '.mipham', 'workflows');

function listRuns(): string[] {
  if (!existsSync(WORKFLOW_DIR)) return [];
  return readdirSync(WORKFLOW_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function loadJournal(
  runId: string,
): Array<Record<string, unknown>> {
  const path = join(WORKFLOW_DIR, runId, 'journal.jsonl');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function loadScript(runId: string): string {
  const path = join(WORKFLOW_DIR, runId, 'script.js');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

function getIdFromUrl(request: Request): string | null {
  try {
    const { searchParams } = new URL(request.url);
    return searchParams.get('id');
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const id = getIdFromUrl(request);

  try {
    // Detail mode: GET /api/workflows?id=xxx
    if (id) {
      const runDir = join(WORKFLOW_DIR, id);
      if (!existsSync(runDir)) {
        return NextResponse.json({ error: 'Run not found' }, { status: 404 });
      }

      const entries = loadJournal(id);
      const script = loadScript(id);

      return NextResponse.json({ id, script, entries });
    }

    // List mode: GET /api/workflows
    const runs = listRuns();
    const data = runs
      .sort()
      .reverse()
      .slice(0, 20)
      .map((runId) => {
        const entries = loadJournal(runId);
        return {
          id: runId,
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
