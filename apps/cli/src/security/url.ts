import dns from 'node:dns'

// ── Protocol allow-list ──
const ALLOWED_PROTOCOLS = ['http:', 'https:']

// ── IPv4 private / reserved ranges ──
const IPV4_BLOCKED = [
  { prefix: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8   loopback
  { prefix: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8    private
  { prefix: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12 private
  { prefix: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16 private
  { prefix: 0x00000000, mask: 0xff000000 }, // 0.0.0.0/8     "this network"
  { prefix: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 link-local
]

/** Validate a URL for SSRF safety. Returns null if safe, or an error string. */
export async function validateUrl(urlStr: string): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(urlStr)
  } catch {
    return `Invalid URL: "${urlStr}"`
  }

  // 1. Protocol allow-list
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    return `URL protocol "${parsed.protocol}" is not allowed. Only http: and https: are permitted.`
  }

  // Hostname may include brackets for IPv6 (e.g. "[::1]") — strip them for checks
  const hostname = parsed.hostname

  // 2. Check for raw IPv4 in hostname
  if (isBlockedIPv4(hostname)) {
    return `URL hostname "${hostname}" resolves to a blocked IP range (private / loopback / link-local).`
  }

  // 3. Check for raw IPv6 loopback / private / IPv4-mapped
  const ipv6Host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  if (isBlockedIPv6(ipv6Host)) {
    return `URL hostname "${hostname}" resolves to a blocked IPv6 address.`
  }

  // 4. DNS rebinding protection: resolve hostname and check resolved IPs.
  //    Uses async dns.promises.lookup — the old sync `dns.lookupSync` never existed,
  //    so this check was previously dead code (always threw → swallowed → "safe").
  try {
    const addresses = await dns.promises.lookup(ipv6Host, { all: true })
    for (const addr of addresses) {
      if (isBlockedIPv4(addr.address)) {
        return `URL hostname "${hostname}" resolved to ${addr.address} (blocked IP range).`
      }
      if (isBlockedIPv6(addr.address)) {
        return `URL hostname "${hostname}" resolved to ${addr.address} (blocked IPv6 address).`
      }
    }
  } catch {
    // DNS resolution failed — the subsequent fetch will fail too; treat as safe.
  }

  return null // safe
}

function isBlockedIPv4(ip: string): boolean {
  // Skip if it's not an IPv4 string
  const parts = ip.split('.')
  if (parts.length !== 4) return false

  const nums = parts.map((p) => parseInt(p, 10))
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return false

  // Use >>> 0 to avoid signed 32-bit overflow for octets > 127
  const asInt = ((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0

  return IPV4_BLOCKED.some(({ prefix, mask }) => (asInt & mask) >>> 0 === prefix >>> 0)
}

function isBlockedIPv6(ip: string): boolean {
  // IPv6 loopback
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true
  // IPv6 link-local (fe80::/10)
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb'))
    return true
  // IPv6 unique local (fc00::/7)
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true
  // IPv6 unspecified
  if (ip === '::' || ip === '0:0:0:0:0:0:0:0') return true

  // IPv4-mapped (::ffff:a.b.c.d / ::ffff:xxxx:xxxx) and IPv4-compatible (::a.b.c.d / ::xxxx:xxxx)
  // — these can smuggle a private IPv4 past the literal-IPv6 checks above.
  const embedded = extractEmbeddedIPv4(ip)
  if (embedded && isBlockedIPv4(embedded)) return true

  return false
}

/** Extract the IPv4 address embedded in an IPv4-mapped / IPv4-compatible IPv6 address. */
function extractEmbeddedIPv4(ip: string): string | null {
  let rest: string | null = null
  const mapped = ip.match(/^::ffff:(.+)$/i)
  const compat = ip.match(/^::([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})$/)
  if (mapped) {
    rest = mapped[1]!
  } else if (compat) {
    rest = `${compat[1]}:${compat[2]}`
  } else {
    return null
  }

  // Dotted-quad form (::ffff:127.0.0.1)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return rest

  // Hex form (::ffff:7f00:1)
  const hex = rest.match(/^([0-9a-fA-F]{1,4}):([0-9a-fA-F]{1,4})$/)
  if (!hex) return null
  const hi = parseInt(hex[1]!, 16)
  const lo = parseInt(hex[2]!, 16)
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}
