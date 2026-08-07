import type { CommandHandler } from '../ui/commands'
import { KeyManager } from '../config/keys-manager'

export const keysCmd: CommandHandler = async (_ctx, args) => {
  const manager = new KeyManager()
  const sub = args[0]?.toLowerCase()

  // /keys rotate <provider>
  if (sub === 'rotate') {
    const provider = args[1]
    if (!provider) {
      return {
        content: 'Usage: /keys rotate <provider>\n\nExample: /keys rotate deepseek',
      }
    }
    // Interactive: prompt user to provide new key via follow-up chat message
    return {
      content: [
        '── Key Rotation ──',
        '',
        `Provider: ${provider}`,
        '',
        'To complete rotation, the new API key must be provided.',
        'Type your new key in chat and the AI will handle rotation securely.',
        '',
        'The old key will be backed up to ~/.mipham/keys/<provider>.backup (chmod 600).',
      ].join('\n'),
      forwardToAI: `The user wants to rotate the API key for provider "${provider}". Ask them to provide the new key value, then:
1. Call KeyManager.rotate("${provider}", newKey) with the provided key
2. The new key should be stored in ~/.mipham/config.json (or appropriate config)
3. Confirm rotation count and backup location
4. Remind them the old key is backed up at ~/.mipham/keys/${provider}.backup`,
    }
  }

  // /keys audit
  if (sub === 'audit') {
    const expired = manager.audit()
    if (expired.length === 0) {
      return {
        content:
          '── Key Audit ──\n\n✅ All keys are within the 90-day rotation window.\n\nNo expired keys found.',
      }
    }

    const lines: string[] = [
      '── Key Audit ──',
      '',
      `⚠️  ${expired.length} key(s) have exceeded the 90-day rotation threshold:`,
      '',
      ...expired.map(
        (k) =>
          `  🔴 ${k.provider.padEnd(16)} ${k.ageDays} days since last rotation (${k.lastRotated.slice(0, 10)})`,
      ),
      '',
      'Rotate expired keys with: /keys rotate <provider>',
    ]
    return { content: lines.join('\n') }
  }

  // /keys (list)
  const keys = manager.list()

  if (keys.length === 0) {
    return {
      content: [
        '── API Keys ──',
        '',
        'No API keys tracked yet.',
        '',
        'Keys are tracked in ~/.mipham/keys.json when you configure providers.',
        'Use /keys rotate <provider> to begin tracking rotation for a provider.',
      ].join('\n'),
    }
  }

  const lines: string[] = [
    '── API Keys ──',
    '',
    'Provider         Age     Rotations   Status',
    '─'.repeat(55),
    ...keys.map((k) => {
      const status = k.expired ? '🔴 EXPIRED' : '🟢 OK'
      return `  ${k.provider.padEnd(16)} ${String(k.ageDays).padStart(4)}d   ${String(k.rotationCount).padStart(5)}       ${status}`
    }),
    '',
    `${keys.length} key(s) tracked.`,
    '',
    'Commands:',
    '  /keys rotate <provider>  — rotate a key',
    '  /keys audit             — check for expired keys',
  ]
  return { content: lines.join('\n') }
}
