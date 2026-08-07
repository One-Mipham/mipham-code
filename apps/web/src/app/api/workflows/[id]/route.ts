import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const WORKFLOW_DIR = join(homedir(), '.mipham', 'workflows');

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const runDir = join(WORKFLOW_DIR, id);

  if (!existsSync(runDir)) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  try {
    // Load journal
    const journalPath = join(runDir, 'journal.jsonl');
    let entries: Array<Record<string, unknown>> = [];
    if (existsSync(journalPath)) {
      const raw = readFileSync(journalPath, 'utf-8');
      entries = raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    }

    // Load script
    const scriptPath = join(runDir, 'script.js');
    let script = '';
    if (existsSync(scriptPath)) {
      script = readFileSync(scriptPath, 'utf-8');
    }

    return NextResponse.json({ id, script, entries });
  } catch {
    return NextResponse.json(
      { error: 'Failed to read run data' },
      { status: 500 },
    );
  }
}
