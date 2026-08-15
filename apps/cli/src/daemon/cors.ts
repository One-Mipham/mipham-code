// apps/cli/src/daemon/cors.ts
//
// CORS middleware for the daemon HTTP API.
// Only origins explicitly listed in MIPHAM_CORS_ORIGINS (comma-separated) are
// allowed cross-origin access. By default (empty) no external origin is allowed,
// so a malicious web page cannot read daemon responses cross-origin.

const ALLOWED_HEADERS = 'Content-Type'
const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'

/**
 * Check whether an origin string refers to localhost.
 */
export function isLocalhostOrigin(origin: string): boolean {
  return origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('[::1]')
}

function getAllowedOrigins(): string[] {
  const raw = process.env.MIPHAM_CORS_ORIGINS || ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isAllowedOrigin(origin: string): boolean {
  return getAllowedOrigins().includes(origin)
}

/**
 * Handle CORS preflight (OPTIONS) requests.
 *
 * Returns a Response with CORS headers only for explicitly allow-listed external
 * origins. Localhost origins need no CORS; unlisted external origins get no CORS
 * headers (the browser blocks the cross-origin read).
 */
export function corsMiddleware(request: Request): Response | null {
  const origin = request.headers.get('origin')
  if (!origin) return null

  if (isLocalhostOrigin(origin) || !isAllowedOrigin(origin)) return null

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers': ALLOWED_HEADERS,
        'Access-Control-Max-Age': '3600',
      },
    })
  }

  return null
}

/**
 * Add CORS headers to a response only for explicitly allow-listed external origins.
 * Localhost / absent / unlisted origins return the response unchanged.
 */
export function addCorsHeaders(response: Response, request: Request): Response {
  const origin = request.headers.get('origin')
  if (!origin || isLocalhostOrigin(origin) || !isAllowedOrigin(origin)) return response

  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS)
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS)

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
