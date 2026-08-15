import { describe, it, expect } from 'vitest'
import { validateUrl } from '../../src/security/url'

describe('validateUrl', () => {
  describe('safe URLs', () => {
    it('allows https:// URLs', async () => {
      expect(await validateUrl('https://example.com')).toBeNull()
    })

    it('allows http:// URLs', async () => {
      expect(await validateUrl('http://example.com')).toBeNull()
    })

    it('allows URLs with paths and query params', async () => {
      expect(await validateUrl('https://api.example.com/v1/search?q=test&limit=10')).toBeNull()
    })

    it('allows URLs with ports', async () => {
      expect(await validateUrl('https://example.com:8443/api')).toBeNull()
    })
  })

  describe('protocol blocking', () => {
    it('rejects file:// protocol', async () => {
      const err = await validateUrl('file:///etc/passwd')
      expect(err).toContain('not allowed')
    })

    it('rejects ftp:// protocol', async () => {
      const err = await validateUrl('ftp://example.com/file')
      expect(err).toContain('not allowed')
    })

    it('rejects gopher:// protocol', async () => {
      const err = await validateUrl('gopher://localhost/')
      expect(err).toContain('not allowed')
    })
  })

  describe('internal IP blocking (raw IPv4)', () => {
    it('rejects 127.0.0.1 (loopback)', async () => {
      const err = await validateUrl('http://127.0.0.1:8080/admin')
      expect(err).toContain('blocked IP')
    })

    it('rejects 127.0.0.0/8 range', async () => {
      const err = await validateUrl('http://127.255.255.255/')
      expect(err).toContain('blocked IP')
    })

    it('rejects 10.0.0.0/8 (private)', async () => {
      const err = await validateUrl('http://10.0.0.1/api')
      expect(err).toContain('blocked IP')
    })

    it('rejects 192.168.0.0/16 (private)', async () => {
      const err = await validateUrl('http://192.168.1.1/')
      expect(err).toContain('blocked IP')
    })

    it('rejects 172.16.0.0/12 (private)', async () => {
      const err = await validateUrl('http://172.16.0.1/')
      expect(err).toContain('blocked IP')
    })

    it('rejects 172.31.255.255 (private upper bound)', async () => {
      const err = await validateUrl('http://172.31.255.255/')
      expect(err).toContain('blocked IP')
    })

    it('rejects 0.0.0.0', async () => {
      const err = await validateUrl('http://0.0.0.0/')
      expect(err).toContain('blocked IP')
    })

    it('rejects 169.254.0.0/16 (link-local)', async () => {
      const err = await validateUrl('http://169.254.169.254/latest/meta-data')
      expect(err).toContain('blocked IP')
    })
  })

  describe('internal IP blocking (IPv6)', () => {
    it('rejects ::1 (IPv6 loopback)', async () => {
      const err = await validateUrl('http://[::1]:8080/')
      expect(err).toContain('blocked')
    })

    it('rejects fe80:: (link-local)', async () => {
      const err = await validateUrl('http://[fe80::1]/')
      expect(err).toContain('blocked')
    })

    it('rejects fc00:: (unique local)', async () => {
      const err = await validateUrl('http://[fc00::1]/')
      expect(err).toContain('blocked')
    })

    it('rejects fd00:: (unique local)', async () => {
      const err = await validateUrl('http://[fd12:3456:7890::1]/')
      expect(err).toContain('blocked')
    })
  })

  describe('IPv4-mapped / IPv4-compatible IPv6', () => {
    it('rejects ::ffff:7f00:1 (IPv4-mapped loopback, hex)', async () => {
      const err = await validateUrl('http://[::ffff:7f00:1]/')
      expect(err).toContain('blocked')
    })

    it('rejects ::ffff:127.0.0.1 (IPv4-mapped loopback, dotted)', async () => {
      const err = await validateUrl('http://[::ffff:127.0.0.1]/')
      expect(err).toContain('blocked')
    })

    it('rejects ::7f00:1 (IPv4-compatible loopback)', async () => {
      const err = await validateUrl('http://[::7f00:1]/')
      expect(err).toContain('blocked')
    })

    it('allows ::ffff:808:808 (IPv4-mapped public 8.8.8.8)', async () => {
      expect(await validateUrl('http://[::ffff:808:808]/')).toBeNull()
    })
  })

  describe('invalid URLs', () => {
    it('rejects completely malformed URL', async () => {
      const err = await validateUrl('not-a-url')
      expect(err).toContain('Invalid URL')
    })

    it('rejects empty string', async () => {
      const err = await validateUrl('')
      expect(err).toContain('Invalid URL')
    })
  })
})
