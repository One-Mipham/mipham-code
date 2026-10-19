/**
 * `--safe-mode` gate.
 *
 * Read at call time, not at import time: `bin/mipham.ts` sets
 * `MIPHAM_SAFE_MODE=1` while parsing argv, which happens after the module
 * graph is evaluated. Only the exact value `1` enables it — an inherited
 * empty string or `0` must not silently disable the user's customizations.
 */
export function isSafeMode(): boolean {
  return process.env.MIPHAM_SAFE_MODE === '1'
}
