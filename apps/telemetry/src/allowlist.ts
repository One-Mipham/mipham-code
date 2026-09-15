import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The label allowlist: which `family.label` counter keys the collector will
 * store under their own name.
 *
 * **Why an allowlist and not a cardinality cap.** The endpoint is public and
 * unauthenticated, so anyone can send anything. A cap is fillable: send 512
 * distinct junk labels for one family and every genuine label is pushed into
 * `__other__` — which is precisely the table `ROADMAP.md` T4 step 4 votes on
 * when deciding which features to delete. An allowlist cannot be filled,
 * because an unrecognised label never gets a slot to occupy.
 *
 * The allowlist is generated from the two registries that actually mint labels
 * (`createToolRegistry()` and the slash-command registry) and checked into
 * `allowlist.json`. `apps/cli/test/integrity/telemetry-contract.test.ts`
 * regenerates it and fails on any difference, so adding a tool or a command
 * without updating this file is a red test rather than a silently folded
 * dimension. Regenerate with:
 *
 *     UPDATE_TELEMETRY_ALLOWLIST=1 pnpm --filter @miphamai/cli test telemetry-contract
 *
 * **Only two families carry labels at all.** `cli_invocations`,
 * `crsi_rule_applications` and `sis_interceptions` are incremented without a
 * label (`engine.ts:1113` etc.), so their wire key has no dot and
 * `normalizeCounters` never consults this map for them.
 */

/** A label set per counter family. A family absent from the map allows no labels. */
export type LabelAllowlist = ReadonlyMap<string, ReadonlySet<string>>

interface AllowlistFile {
  /** Bumped by hand if the file's shape ever changes. */
  readonly version: number
  /** Human-readable note on where the contents come from, restated in the file. */
  readonly generatedFrom: readonly string[]
  readonly labels: Readonly<Record<string, readonly string[]>>
}

const ALLOWLIST_PATH = join(dirname(fileURLToPath(import.meta.url)), 'allowlist.json')

/** Load from the checked-in JSON. Throws if it is missing — there is no empty fallback. */
export function loadAllowlist(path: string = ALLOWLIST_PATH): LabelAllowlist {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as AllowlistFile
  const map = new Map<string, Set<string>>()
  for (const [family, labels] of Object.entries(parsed.labels)) {
    map.set(family, new Set(labels))
  }
  return map
}

/**
 * An allowlist that permits nothing.
 *
 * Used by tests that exercise `validateEvent` in isolation, where resolving
 * every label to `__other__` is the point. Production always loads the file:
 * an empty allowlist there would fold every label and quietly destroy the
 * dimension the whole collector exists to produce, so it is not a default
 * anywhere on the request path.
 */
export function emptyAllowlist(): LabelAllowlist {
  return new Map()
}
