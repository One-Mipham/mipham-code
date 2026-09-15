import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Aggregator } from './aggregate.js'
import type { LabelAllowlist } from './allowlist.js'
import { MAX_BODY_BYTES } from './schema.js'
import { parseBody, validateEvent } from './validate.js'

/**
 * The HTTP surface: one path, one method, six status codes.
 *
 * Every code here is chosen from the client's ack table (`transport.ts:58`),
 * not from HTTP convention:
 *
 *   204  accepted, and the only success. The client acks and deletes.
 *   400  the envelope cannot be used at all. The client deletes it — which is
 *        what we want, because retrying will not help and a poison message that
 *        stays queued blocks everything behind it.
 *   404  any path but `/v1/events`. Also deleted, also intended.
 *   405  a non-POST method on that path. Same.
 *   413  body over the limit. Also a 4xx, so also deleted — intended.
 *   503  overloaded. The client retries twice and then keeps the event queued.
 *   500  the aggregate could not be written. Same retry path as 503.
 *
 * **429 must never be returned.** The client treats it as retryable *and* as a
 * 4xx: it retries twice, then the `>= 400 && < 500` branch acks and deletes.
 * So a 429 is silent permanent data loss, and it costs three requests to
 * achieve it. 503 is the retry-preserving code.
 *
 * **`Retry-After` must never be sent** on any response, for the same class of
 * reason: the client parses it with no upper bound and turns it into a bare
 * `setTimeout` that holds the event loop open.
 *
 * **No 3xx, ever.** `fetchWithRetry` passes an init with no `redirect` key, so
 * undici follows redirects by default; a redirect would silently re-send the
 * body somewhere we did not choose.
 */

/** The only path this service answers. Fixed by the existing Python client. */
export const EVENTS_PATH = '/v1/events'

export interface RequestDeps {
  readonly aggregator: Aggregator
  readonly allowlist: LabelAllowlist
  readonly canonicalHost: string
  readonly onAccepted: () => void
}

/**
 * The complete set of responses this service can produce.
 *
 * Written as a closed literal union rather than `number` so that adding a code
 * is a deliberate act: 429 and every 3xx are absent because the client's ack
 * table makes them destructive, and that is easier to keep true if the type
 * cannot express them.
 */
export type Verdict = { status: 204 | 400 | 404 | 405 | 413 | 500 | 503 }

/**
 * Read the body, refusing before reading when the declared length is too large.
 *
 * The early return matters: a 413 that first buffers 64 MB is not a limit, it
 * is a memory exhaustion primitive. `Content-Length` is attacker-controlled and
 * may be absent (chunked), so the streaming path counts bytes and destroys the
 * socket on overflow rather than pretending a declared length is a guarantee.
 */
export async function readBody(
  request: IncomingMessage,
): Promise<{ ok: true; body: string } | { ok: false }> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) {
      request.destroy()
      return { ok: false }
    }
    chunks.push(buf)
  }
  return { ok: true, body: Buffer.concat(chunks).toString('utf-8') }
}

/**
 * Classify a request without reading the body.
 *
 * Split out so the router can decide about the 413 before allocating anything,
 * and so route/method behaviour is testable without a socket.
 */
export function route(path: string, method: string | undefined): Verdict | undefined {
  if (path !== EVENTS_PATH) return { status: 404 }
  if (method !== 'POST') return { status: 405 }
  return undefined
}

/** Turn a `Verdict` into a response. Never sets `Retry-After`; never redirects. */
export function send(response: ServerResponse, verdict: Verdict): void {
  // An empty body on every code: nothing here is for a human to read, and a
  // body is one more thing that could carry data back out.
  response.writeHead(verdict.status)
  response.end()
}

/**
 * Handle one valid-path request. The caller has already routed it.
 *
 * Ordering is deliberate: the body limit comes before parsing, the envelope
 * check before aggregation, and the write failure is the *only* path to a 5xx.
 */
export async function handleEvent(
  request: IncomingMessage,
  response: ServerResponse,
  deps: RequestDeps,
): Promise<void> {
  const read = await readBody(request)
  if (!read.ok) {
    deps.aggregator.noteBodyTooLarge()
    send(response, { status: 413 })
    return
  }

  const parsed = parseBody(read.body)
  if (!parsed.ok) {
    deps.aggregator.noteRejected('not-json')
    send(response, { status: 400 })
    return
  }

  const host = request.headers.host
  if (host !== undefined && host !== deps.canonicalHost) deps.aggregator.noteHostMismatch()

  // Counted from here on, not in `record`: everything below may still be
  // refused with a 400, and "parsed but rejected" is the number that tells an
  // operator a client is sending something this collector does not understand.
  deps.aggregator.noteReceived()

  const contentType = request.headers['content-type']
  const result = validateEvent(
    parsed.value,
    deps.allowlist,
    Array.isArray(contentType) ? contentType[0] : contentType,
  )

  if (!result.ok) {
    deps.aggregator.noteRejected(result.reason)
    send(response, { status: 400 })
    return
  }

  deps.aggregator.noteObservations(result.notes)
  deps.aggregator.record(result.event, Date.now())
  deps.onAccepted()

  // 204 whether or not this was a duplicate: from the client's side both are
  // "delivered, stop retrying". Saying anything else about a duplicate would
  // make it retry forever.
  send(response, { status: 204 })
}
