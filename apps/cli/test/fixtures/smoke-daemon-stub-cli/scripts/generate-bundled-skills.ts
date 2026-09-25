/**
 * No-op stand-in for `apps/cli/scripts/generate-bundled-skills.ts`.
 *
 * `scripts/smoke-daemon.sh` runs `<cli-dir>/scripts/generate-bundled-skills.ts`
 * before compiling, and the stub CLI has no skills to embed. The step is kept
 * rather than skipped so the guard cases exercise the same command sequence the
 * real invocations do — the subject under test is the script, and a step that
 * only exists for the real artifact must still be *called* in the same order.
 */
console.log('stub: no skills to bundle')
