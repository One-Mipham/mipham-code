import type { BundleLine } from './bundle'

export function dumpConfig(lines: BundleLine[]): string {
  return lines.map((l) => `${l.id}\t${l.kind}\t${JSON.stringify(l.config)}`).join('\n')
}
