/**
 * Deterministic model streams for the keyless E2E path.
 *
 * These are *responses only* — no `ChatRequest`, because a recorded request
 * embeds the recording machine's system prompt (its cwd and instruction
 * files). `replayChunks` ignores the request anyway, so the smaller shape is
 * the one that can live in the repo.
 *
 * What this proves and what it does not: the keyless run exercises the real
 * pipeline (config → providers → context → engine → tools) with a scripted
 * model, so a plumbing break fails here. It says nothing about any model's
 * answer quality — that is what the live path (a key in the environment) is for.
 */
import type { StreamChunk } from '../../../src/shared'

export const REPLAY_STREAMS = {
  greeting: [[{ type: 'text', content: 'Hi there' }, { type: 'stop' }]],
  math: [[{ type: 'text', content: '4' }, { type: 'stop' }]],
  code: [
    [
      { type: 'text', content: 'const add = (a: number, b: number): number => a + b' },
      { type: 'stop' },
    ],
  ],
  minimal: [[{ type: 'text', content: 'ok' }, { type: 'stop' }]],
  // A deterministic provider failure: the engine must surface it and stop,
  // not retry or fall back (a second call would desync a replay anyway).
  providerFailure: [[{ type: 'error', error: 'simulated provider failure', retryable: false }]],
  // Turn 1 answers, turn 2 answers from history. The assertion that history was
  // actually sent is made on the recorded request, not on this text.
  multiTurn: [
    [{ type: 'text', content: 'OK Alice' }, { type: 'stop' }],
    [{ type: 'text', content: 'Alice' }, { type: 'stop' }],
  ],
} satisfies Record<string, StreamChunk[][]>

/** Turn 1 calls Read on `filePath`; turn 2 answers after seeing the tool result. */
export function readToolStream(filePath: string): StreamChunk[][] {
  return [
    [
      {
        type: 'tool_use',
        toolUse: {
          type: 'tool_use',
          id: 'call_read_file',
          name: 'Read',
          input: { file_path: filePath },
        },
      },
      { type: 'stop' },
    ],
    [{ type: 'text', content: 'The file says: Hello from Mipham E2E test!' }, { type: 'stop' }],
  ]
}

/** The text the Read fixture returns; also what the temp file contains. */
export const READ_RESULT_TEXT = 'Hello from Mipham E2E test!'
