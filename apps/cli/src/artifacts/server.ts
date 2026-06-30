import { createServer, type Server } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { ARTIFACT_ALLOWED_EXTENSIONS } from '../shared/constants'
import { readManifest } from './manifest'
import type { ArtifactEntry } from '../shared/types'

// ── SSE client tracking ──
interface SseClient {
  id: number
  res: any
}

/**
 * Embedded HTTP server for serving artifact files (.html, .svg).
 *
 * Phase 2 additions:
 * - Gallery page at / with dark-themed card layout
 * - SSE /events endpoint for live reload
 * - Versioned file serving (name.v2.html)
 * - Port auto-increment on conflict
 */
export class ArtifactServer {
  private server: Server | null = null
  private port: number
  private artifactsDir: string
  private started = false
  private sseClients: SseClient[] = []
  private sseIdCounter = 0

  constructor(artifactsDir: string, preferredPort: number) {
    this.artifactsDir = artifactsDir
    this.port = preferredPort
  }

  /** Notify all connected SSE clients to reload. Called after artifact changes. */
  notifyReload(): void {
    for (const client of this.sseClients) {
      try {
        client.res.write('event: reload\ndata: {}\n\n')
      } catch {
        // Client disconnected — will be cleaned up on next request
      }
    }
  }

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
      }
    }

    throw new Error(
      `Artifact server could not find an available port after ${maxTries} attempts.`,
    )
  }

  stop(): void {
    // Close all SSE connections
    for (const client of this.sseClients) {
      try { client.res.end() } catch { /* ignore */ }
    }
    this.sseClients = []

    if (this.server) {
      this.server.close()
      this.server = null
      this.started = false
    }
  }

  getPort(): number { return this.port }
  isRunning(): boolean { return this.started }

  resolveFile(urlPath: string): { filePath: string; error?: string; status?: number } {
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

  // ── Private ──

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

    // SSE endpoint
    if (urlPath === '/events') {
      this.handleSse(res)
      return
    }

    // Gallery page
    if (urlPath === '/' || urlPath === '/index.html') {
      this.serveGallery(res)
      return
    }

    // Artifact file
    this.serveArtifact(urlPath, res)
  }

  // ── SSE ──

  private handleSse(res: any): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    const client: SseClient = { id: ++this.sseIdCounter, res }
    this.sseClients.push(client)

    // Send initial heartbeat
    res.write(':ok\n\n')

    // Clean up on close
    res.on('close', () => {
      this.sseClients = this.sseClients.filter((c) => c.id !== client.id)
    })
  }

  // ── Gallery Page ──

  private serveGallery(res: any): void {
    const manifest = readManifest(this.artifactsDir)
    const artifacts = manifest.artifacts

    const cards = artifacts.length === 0
      ? `<div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: #666;">
           <p style="font-size: 48px; margin: 0 0 16px 0;">🎨</p>
           <p style="font-size: 16px;">No artifacts yet.</p>
           <p style="font-size: 13px; color: #555;">Ask the AI to create one with the Artifact tool.</p>
         </div>`
      : artifacts.map((a) => this.artifactCard(a)).join('\n')

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mipham Code — Artifacts</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #c9d1d9; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --orange: #d2991d; --purple: #a371f7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    min-height: 100vh;
  }
  header {
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 20px 32px; display: flex; align-items: center; justify-content: space-between;
  }
  header h1 { font-size: 20px; font-weight: 600; }
  header .meta { font-size: 13px; color: var(--muted); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px; padding: 24px 32px;
  }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 20px; transition: border-color .15s;
    text-decoration: none; color: inherit; display: block;
  }
  .card:hover { border-color: var(--accent); }
  .card .icon { font-size: 32px; margin-bottom: 12px; }
  .card .name { font-size: 15px; font-weight: 600; margin-bottom: 8px; color: var(--accent); }
  .card .row { font-size: 12px; color: var(--muted); margin-top: 4px; display: flex; gap: 12px; }
  .card .badge {
    display: inline-block; padding: 1px 6px; border-radius: 3px;
    font-size: 11px; font-weight: 600;
  }
  .badge-html { background: #1f3a5f; color: var(--accent); }
  .badge-svg { background: #2d1f4e; color: var(--purple); }
  .badge-version { background: #2d2d1f; color: var(--orange); }
  footer {
    padding: 16px 32px; border-top: 1px solid var(--border);
    font-size: 12px; color: var(--muted); display: flex; gap: 16px;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); display: inline-block; margin-right: 4px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>🎨 Mipham Code Artifacts</h1>
    <p style="font-size:13px;color:var(--muted);margin-top:4px;">
      Interactive visual output from your AI sessions
    </p>
  </div>
  <div class="meta">
    <div><span class="dot"></span> Server running</div>
    <div>Port ${this.port}</div>
  </div>
</header>
<div class="grid">${cards}</div>
<footer>
  <span>${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}</span>
  <span>·</span>
  <span>Open in terminal: <code>/artifact open &lt;name&gt;</code></span>
  <span>·</span>
  <span>Auto-refresh active</span>
</footer>
<script>
  // SSE auto-refresh
  const es = new EventSource('/events')
  es.addEventListener('reload', () => location.reload())
</script>
</body>
</html>`

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
    res.end(html)
  }

  private artifactCard(a: ArtifactEntry): string {
    const icon = a.type === 'svg' ? '🖼' : '📊'
    const sizeStr = a.size < 1024 ? `${a.size}B`
      : a.size < 1_048_576 ? `${(a.size / 1024).toFixed(1)}KB`
      : `${(a.size / 1_048_576).toFixed(1)}MB`
    const date = a.createdAt.slice(0, 16).replace('T', ' ')
    const versionInfo = a.versions && a.versions.length > 1
      ? `<span class="badge badge-version">${a.versions.length} versions</span>`
      : ''

    return `<a class="card" href="/${a.sessionId}/${a.name}.${a.type === 'svg' ? 'svg' : 'html'}">
  <div class="icon">${icon}</div>
  <div class="name">${this.escapeHtml(a.name)}</div>
  <div class="row">
    <span class="badge badge-${a.type}">${a.type.toUpperCase()}</span>
    <span>${sizeStr}</span>
    <span>${date}</span>
    ${versionInfo}
  </div>
  <div class="row">
    <span>session: ${a.sessionId}</span>
  </div>
</a>`
  }

  // ── Artifact Serving ──

  private serveArtifact(urlPath: string, res: any): void {
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

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}
