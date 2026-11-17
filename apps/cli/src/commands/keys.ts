import type { CommandHandler } from '../ui/commands'
import { KeyManager } from '../config/keys-manager'
import { getProviderApiKey } from '../config/loader'

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

    // The key is read from the environment, never from chat: a key typed into
    // the prompt becomes part of the conversation transcript and the model
    // context. Per-provider variable first, generic one as the fallback.
    const envName = `MIPHAM_ROTATE_KEY_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
    const newKey = process.env[envName] ?? process.env.MIPHAM_ROTATE_KEY
    if (!newKey) {
      return {
        content: [
          '── Key Rotation ──',
          '',
          `Provider: ${provider}`,
          '',
          'No key supplied.',
          `Set ${envName} (or MIPHAM_ROTATE_KEY) and rerun:`,
          '',
          `  ${envName}=... /keys rotate ${provider}`,
          '',
          'The key is read from the environment so it never enters the conversation transcript.',
          'The old rotation metadata is backed up to ~/.mipham/keys/<provider>.backup (chmod 600).',
        ].join('\n'),
      }
    }

    const result = manager.rotate(provider, newKey)
    if (!result.success) {
      return { content: `── Key Rotation ──\n\n✗ ${result.message}` }
    }
    return { content: `── Key Rotation ──\n\n✅ ${result.message}` }
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

  // /keys view <provider> — show the plaintext API key (decrypting if stored encrypted)
  if (sub === 'view' || sub === 'show') {
    const provider = args[1]
    if (!provider) {
      return { content: 'Usage: /keys view <provider>\n\nExample: /keys view deepseek' }
    }
    const key = getProviderApiKey(provider)
    if (key === null) {
      return {
        content: `No API key found for provider "${provider}".\n\nIf it was stored encrypted, it may be unreadable (missing/corrupt credential key).`,
      }
    }
    return {
      content: [
        '── Key View ──',
        '',
        `Provider: ${provider}`,
        `API Key:  ${key}`,
        '',
        '⚠️  This is your plaintext API key. Do not share it or paste it anywhere.',
        '    Rotate it at any time with /keys rotate <provider>.',
      ].join('\n'),
    }
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
