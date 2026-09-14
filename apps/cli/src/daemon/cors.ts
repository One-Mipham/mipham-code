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
 * Reject any request whose Origin is present but not allow-listed.
 *
 * The CORS headers above only stop a page from *reading* a reply — they do not
 * stop it from *sending* the request (a `text/plain` body is a CORS-safelisted
 * content type, so no preflight is triggered at all), and WebSocket handshakes
 * are not subject to the same-origin policy in the first place. Origin is the
 * one signal that distinguishes a foreign page from the CLI, which sends none:
 * absent Origin passes through unchanged, any other Origin must be listed in
 * MIPHAM_CORS_ORIGINS. Note that `isLocalhostOrigin` is deliberately NOT used
 * here — its substring match would accept `https://localhost.evil.example`.
 */
export function originMiddleware(request: Request): Response | null {
  const origin = request.headers.get('origin')
  if (!origin || isAllowedOrigin(origin)) return null
  return Response.json({ ok: false, error: 'Origin not allowed' }, { status: 403 })
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
