// apps/cli/src/daemon/cors.ts
//
// CORS middleware for the daemon HTTP API.
// Handles preflight OPTIONS requests and provides helpers for
// adding CORS headers to responses from external origins.

const ALLOWED_HEADERS = 'Authorization, Content-Type'
const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'

/**
 * Check whether an origin string refers to localhost.
 */
export function isLocalhostOrigin(origin: string): boolean {
  return origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('[::1]')
}

/**
 * Handle CORS preflight (OPTIONS) requests.
 *
 * Returns a Response with appropriate CORS headers for preflight,
 * or null if the request does not need CORS handling (not a preflight,
 * or origin is localhost).
 *
 * For non-preflight requests with an external Origin, the caller should
 * use `addCorsHeaders` to attach CORS headers to the response.
 */
export function corsMiddleware(request: Request): Response | null {
  const origin = request.headers.get('origin')
  if (!origin) return null

  // Skip localhost origins — no CORS needed
  if (isLocalhostOrigin(origin)) return null

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers': ALLOWED_HEADERS,
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  return null
}

/**
 * Add CORS headers to a response when the request has an external origin.
 * If the origin is localhost or absent, the response is returned unchanged.
 */
export function addCorsHeaders(response: Response, request: Request): Response {
  const origin = request.headers.get('origin')
  if (!origin || isLocalhostOrigin(origin)) return response

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
