import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolDefinition } from '../../shared/index.ts'
import { ARTIFACTS_DIR, ARTIFACT_MAX_SIZE } from '../../shared/constants'
import { addToManifest } from '../../artifacts/manifest'

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/

export const artifactTool: ToolDefinition = {
  name: 'Artifact',
  description:
    'Create an interactive HTML or SVG artifact that opens in the browser. Use for dashboards, visualizations, reports, and interactive demos. Content must be self-contained — no external CDN references.',
  category: 'artifact',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short kebab-case name (e.g. "user-dashboard", "pipeline-diagram")',
      },
      type: {
        type: 'string',
        enum: ['html', 'svg'],
        description: 'Artifact type',
      },
      content: {
        type: 'string',
        description: 'Full HTML or SVG content (self-contained, inline CSS/JS only)',
      },
    },
    required: ['name', 'type', 'content'],
  },
  async execute(params, ctx) {
    const name = params.name as string
    const type = params.type as string
    const content = params.content as string

    // Validate name
    if (!NAME_PATTERN.test(name) || name.length < 3) {
      return {
        success: false,
        content: '',
        error:
          `Invalid artifact name "${name}". Use kebab-case (letters, numbers, hyphens), ` +
          `at least 3 characters, e.g. "my-dashboard".`,
      }
    }

    // Validate size
    const size = Buffer.byteLength(content, 'utf-8')
    if (size > ARTIFACT_MAX_SIZE) {
      return {
        success: false,
        content: '',
        error: `Content size ${(size / 1_048_576).toFixed(1)}MB exceeds ${ARTIFACT_MAX_SIZE / 1_048_576}MB limit.`,
      }
    }

    // Determine output paths
    const baseDir = join(ctx.cwd, ARTIFACTS_DIR)
    const sessionDir = join(baseDir, ctx.sessionId)
    mkdirSync(sessionDir, { recursive: true })

    const ext = type === 'svg' ? '.svg' : '.html'
    const filename = `${name}${ext}`
    const filepath = join(sessionDir, filename)

    // Start server if not running
    let port: number | undefined
    if (ctx.artifactServer && !ctx.artifactServer.isRunning()) {
      port = await ctx.artifactServer.start()
    } else if (ctx.artifactServer) {
      port = ctx.artifactServer.getPort()
    }

    // Write artifact
    writeFileSync(filepath, content, 'utf-8')

    // Build URL and manifest entry
    const url = port
      ? `http://localhost:${port}/${ctx.sessionId}/${filename}`
      : `file://${filepath}`

    addToManifest(
      baseDir,
      {
        name,
        path: filepath,
        url,
        size,
        type: type as 'html' | 'svg',
        createdAt: new Date().toISOString(),
        sessionId: ctx.sessionId,
      },
      port,
    )

    return {
      success: true,
      content: [
        `✓ Artifact "${name}" saved.`,
        `   URL:  ${url}`,
        `   Size: ${size.toLocaleString()} bytes`,
        ``,
        `Open in browser: /artifact open ${name}`,
        `List all:         /artifact list`,
      ].join('\n'),
    }
  },
}
