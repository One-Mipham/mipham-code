import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { saveProviderApiKey } from './loader'

const MIPHAM_HOME = join(homedir(), '.mipham')
const KEYS_FILE = join(MIPHAM_HOME, 'keys.json')
const EXPIRY_DAYS = 90

export interface KeyEntry {
  createdAt: string
  lastRotated: string
  rotationCount: number
  provider: string
}

export interface KeyStatus {
  provider: string
  createdAt: string
  lastRotated: string
  rotationCount: number
  ageDays: number
  expired: boolean
}

export interface KeysData {
  [provider: string]: KeyEntry
}

function loadKeys(): KeysData {
  if (!existsSync(KEYS_FILE)) return {}
  try {
    const raw = readFileSync(KEYS_FILE, 'utf-8')
    return JSON.parse(raw) as KeysData
  } catch {
    return {}
  }
}

function saveKeys(data: KeysData): void {
  mkdirSync(dirname(KEYS_FILE), { recursive: true })
  // 从前这里「转了一半」：先写一个固定名的 `.tmp`，**然后不 rename、直接再写一遍
  // 目标**。留在磁盘上的 `.tmp` 是废物，目标仍然非原子 —— 并发 `/keys rotate` 撞进
  // 同一个临时名，或写到一半被打断，`loadKeys` 把不可解析的 JSON 吞成 `{}`
  // （见上面的 catch）⇒ 全部轮换元数据静默消失。atomicWriteFileSync 自己写唯一名
  // 临时文件再 rename，两者一起解决。
  atomicWriteFileSync(KEYS_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

function daysSince(iso: string): number {
  const then = new Date(iso).getTime()
  const now = Date.now()
  return Math.floor((now - then) / (1000 * 60 * 60 * 24))
}

export class KeyManager {
  list(): KeyStatus[] {
    const data = loadKeys()
    return Object.entries(data).map(([provider, entry]) => ({
      provider,
      createdAt: entry.createdAt,
      lastRotated: entry.lastRotated,
      rotationCount: entry.rotationCount,
      ageDays: daysSince(entry.lastRotated),
      expired: daysSince(entry.lastRotated) > EXPIRY_DAYS,
    }))
  }

  rotate(provider: string, newKey: string): { success: boolean; message: string } {
    // Persist the new key first — the actual rotation. Metadata below is only
    // bookkeeping; without writing the key, "rotate" would be a silent no-op.
    if (!saveProviderApiKey(provider, newKey)) {
      return {
        success: false,
        message: `Rotation aborted: failed to persist new key for "${provider}".`,
      }
    }

    const data = loadKeys()
    const now = new Date().toISOString()
    const existing = data[provider]

    // Backup old entry if it exists
    if (existing) {
      const backupDir = join(MIPHAM_HOME, 'keys')
      mkdirSync(backupDir, { recursive: true })
      const backupPath = join(backupDir, `${provider}.backup`)
      writeFileSync(backupPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 })
      try {
        chmodSync(backupPath, 0o600)
      } catch {
        // Windows
      }

      data[provider] = {
        createdAt: existing.createdAt,
        lastRotated: now,
        rotationCount: existing.rotationCount + 1,
        provider,
      }
    } else {
      data[provider] = {
        createdAt: now,
        lastRotated: now,
        rotationCount: 1,
        provider,
      }
    }

    saveKeys(data)
    return {
      success: true,
      message: `Key for "${provider}" rotated (rotation #${data[provider]!.rotationCount}). Backup saved to ~/.mipham/keys/${provider}.backup`,
    }
  }

  audit(): KeyStatus[] {
    return this.list().filter((k) => k.expired)
  }

  getExpiryReminder(): string | null {
    const expired = this.audit()
    if (expired.length === 0) return null

    const lines = expired.map(
      (k) =>
        `  - ${k.provider}: last rotated ${k.ageDays} days ago (${EXPIRY_DAYS}-day threshold exceeded)`,
    )
    return `⚠️  API key rotation overdue:\n${lines.join('\n')}\n\nRun /keys rotate <provider> to rotate.`
  }

  ensureEntry(provider: string): void {
    const data = loadKeys()
    if (!data[provider]) {
      const now = new Date().toISOString()
      data[provider] = {
        provider,
        createdAt: now,
        lastRotated: now,
        rotationCount: 0,
      }
      saveKeys(data)
    }
  }
}
