import type { ToolDefinition } from '../../shared/index.ts'

const DANGEROUS_COMMANDS = ['push --force', 'reset --hard', 'clean -fd', 'branch -D']

export const gitTool: ToolDefinition = {
  name: 'Git',
  description: 'Execute git commands. Dangerous operations (force push, hard reset) are blocked.',
  category: 'exec',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Git subcommand + args (e.g., "status", "log --oneline")',
      },
    },
    required: ['command'],
  },
  async execute(params, ctx) {
    const command = params.command as string

    for (const dangerous of DANGEROUS_COMMANDS) {
      if (command.includes(dangerous)) {
        return {
          success: false,
          content: '',
          error: `Dangerous git command blocked: "${dangerous}". Run manually if intended.`,
        }
      }
    }

    try {
      const proc = Bun.spawn(['git', ...command.split(/\s+/)], {
        cwd: ctx.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = await new Response(proc.stdout).text()
      const exitCode = await proc.exited

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        return {
          success: false,
          content: '',
          error: `Git error (exit ${exitCode}): ${stderr.slice(0, 1000)}`,
        }
      }

      return {
        success: true,
        content: output.slice(0, 50_000) || '(no output)',
      }
    } catch (err) {
      return {
        success: false,
        content: '',
        error: `Git execution failed: ${String(err)}`,
      }
    }
  },
}
