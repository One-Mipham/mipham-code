export interface CacheStatus {
  totalMessages: number;
  cachedMessages: number;
  cachedTokens: number;
  uncachedTokens: number;
}

export interface CacheTracker {
  isInCache(msg: unknown): boolean;
  getStatus(): CacheStatus;
  invalidate(msg: unknown): void;
}

/**
 * Estimate token count for a text string.
 *
 * Character-class-aware heuristic:
 *   - CJK / emoji: ~1.5 chars per token
 *   - Other scripts: ~4 chars per token
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  let latin = 0;

  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff)
    ) {
      cjk++;
    } else {
      latin++;
    }
  }

  return Math.max(1, Math.ceil(cjk / 1.5 + latin / 4));
}

/** Estimate tokens for a message, including role overhead. */
export function estimateMessageTokens(msg: {
  role: string;
  content: unknown;
}): number {
  const roleTokens = 4; // approx overhead for role
  if (typeof msg.content === 'string') {
    return roleTokens + estimateTokens(msg.content);
  }
  if (Array.isArray(msg.content)) {
    let total = roleTokens;
    for (const block of msg.content) {
      if (block && typeof block === 'object' && 'text' in block) {
        total += estimateTokens(String((block as { text: string }).text));
      } else {
        total += estimateTokens(JSON.stringify(block));
      }
    }
    return total;
  }
  return roleTokens + estimateTokens(JSON.stringify(msg.content));
}

/** No-op cache tracker for when prompt caching is unavailable. */
export class NoopCacheTracker implements CacheTracker {
  isInCache(_msg: unknown): boolean {
    return false;
  }
  getStatus(): CacheStatus {
    return {
      totalMessages: 0,
      cachedMessages: 0,
      cachedTokens: 0,
      uncachedTokens: 0,
    };
  }
  invalidate(_msg: unknown): void {}
}
