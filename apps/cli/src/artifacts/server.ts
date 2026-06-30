import { createServer, type Server } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { ARTIFACT_ALLOWED_EXTENSIONS } from '../shared/constants'

/**
 * Embedded HTTP server for serving artifact files (.html, .svg).
 *
 * - Only GET requests allowed
 * - Only .html and .svg extensions served
 * - Path traversal rejected
 * - CSP headers applied to all responses
 * - Port auto-increment on conflict
 */
export class ArtifactServer {
  private server: Server | null = null
  private port: number
  private artifactsDir: string
  private started = false

  constructor(artifactsDir: string, preferredPort: number) {
    this.artifactsDir = artifactsDir
    this.port = preferredPort
  }

  /**
   * Start the server. If the preferred port is in use, try up to
   * ARTIFACT_MAX_PORT_TRIES ports higher before giving up.
   *
   * @returns The actual port the server is listening on.
   */
  async start(maxTries = 10): Promise<number> {
    if (this.started) return this.port

    for (let attempt = 0; attempt < maxTries; attempt++) {
      const port = this.port + attempt
      try {
        await this.listenOn(port)
        this.port = port
        this.started = true
        return port
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
        // Port in use — try next
      }
    }

    throw new Error(
      `Artifact server could not find an available port after ${maxTries} attempts (starting at ${this.port}).`,
    )
  }

  /** Stop the server gracefully. */
  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
      this.started = false
    }
  }

  getPort(): number {
    return this.port
  }

  isRunning(): boolean {
    return this.started
  }

  /** Resolve a request path to a file path, rejecting traversal and blocked extensions. */
  resolveFile(urlPath: string): { filePath: string; error?: string; status?: number } {
    // Strip leading slash
    const cleaned = urlPath.replace(/^\/+/, '')
    const normalized = normalize(cleaned)
    if (normalized.startsWith('..') || normalized.includes('/../')) {
      return { filePath: '', error: 'Path traversal rejected', status: 403 }
    }

    const fullPath = join(this.artifactsDir, normalized)
    const ext = extname(fullPath).toLowerCase()
    if (!ARTIFACT_ALLOWED_EXTENSIONS.includes(ext)) {
      return { filePath: '', error: `File type "${ext}" not served`, status: 403 }
    }

    return { filePath: fullPath }
  }

  private listenOn(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        this.handleRequest(req, res)
      })

      srv.on('error', reject)

      srv.listen(port, () => {
        this.server = srv
        resolve()
      })
    })
  }

  private handleRequest(req: { method?: string; url?: string }, res: any): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' })
      res.end('Method Not Allowed')
      return
    }

    const urlPath = req.url || '/'
    const { filePath, error, status } = this.resolveFile(urlPath)

    if (error) {
      res.writeHead(status || 403, { 'Content-Type': 'text/plain' })
      res.end(error)
      return
    }

    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Artifact not found')
      return
    }

    const ext = extname(filePath).toLowerCase()
    const mimeType = ext === '.svg' ? 'image/svg+xml' : 'text/html; charset=utf-8'
    const size = statSync(filePath).size

    // CSP: allow inline styles, block all scripts and external resources
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': size,
      'Content-Security-Policy':
        "default-src 'self'; style-src 'unsafe-inline'; script-src 'none'; img-src data: 'self';",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    })

    const stream = createReadStream(filePath)
    stream.pipe(res)
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end('Stream error')
      }
    })
  }
}
