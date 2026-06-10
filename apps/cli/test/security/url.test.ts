import { describe, it, expect } from 'vitest'
import { validateUrl } from '../../src/security/url'

describe('validateUrl', () => {
  describe('safe URLs', () => {
    it('allows https:// URLs', () => {
      expect(validateUrl('https://example.com')).toBeNull()
    })

    it('allows http:// URLs', () => {
      expect(validateUrl('http://example.com')).toBeNull()
    })

    it('allows URLs with paths and query params', () => {
      expect(validateUrl('https://api.example.com/v1/search?q=test&limit=10')).toBeNull()
    })

    it('allows URLs with ports', () => {
      expect(validateUrl('https://example.com:8443/api')).toBeNull()
    })
  })

  describe('protocol blocking', () => {
    it('rejects file:// protocol', () => {
      const err = validateUrl('file:///etc/passwd')
      expect(err).toContain('not allowed')
    })

    it('rejects ftp:// protocol', () => {
      const err = validateUrl('ftp://example.com/file')
      expect(err).toContain('not allowed')
    })

    it('rejects gopher:// protocol', () => {
      const err = validateUrl('gopher://localhost/')
      expect(err).toContain('not allowed')
    })
  })

  describe('internal IP blocking (raw IPv4)', () => {
    it('rejects 127.0.0.1 (loopback)', () => {
      const err = validateUrl('http://127.0.0.1:8080/admin')
      expect(err).toContain('blocked IP')
    })

    it('rejects 127.0.0.0/8 range', () => {
      const err = validateUrl('http://127.255.255.255/')
      expect(err).toContain('blocked IP')
    })

    it('rejects 10.0.0.0/8 (private)', () => {
      const err = validateUrl('http://10.0.0.1/api')
      expect(err).toContain('blocked IP')
    })

    it('rejects 192.168.0.0/16 (private)', () => {
      const err = validateUrl('http://192.168.1.1/')
      expect(err).toContain('blocked IP')
    })

    it('rejects 172.16.0.0/12 (private)', () => {
      const err = validateUrl('http://172.16.0.1/')
      expect(err).toContain('blocked IP')
    })

    it('rejects 172.31.255.255 (private upper bound)', () => {
      const err = validateUrl('http://172.31.255.255/')
      expect(err).toContain('blocked IP')
    })

    it('rejects 0.0.0.0', () => {
      const err = validateUrl('http://0.0.0.0/')
      expect(err).toContain('blocked IP')
    })

    it('rejects 169.254.0.0/16 (link-local)', () => {
      const err = validateUrl('http://169.254.169.254/latest/meta-data')
      expect(err).toContain('blocked IP')
    })
  })

  describe('internal IP blocking (IPv6)', () => {
    it('rejects ::1 (IPv6 loopback)', () => {
      const err = validateUrl('http://[::1]:8080/')
      expect(err).toContain('blocked')
    })

    it('rejects fe80:: (link-local)', () => {
      const err = validateUrl('http://[fe80::1]/')
      expect(err).toContain('blocked')
    })

    it('rejects fc00:: (unique local)', () => {
      const err = validateUrl('http://[fc00::1]/')
      expect(err).toContain('blocked')
    })

    it('rejects fd00:: (unique local)', () => {
      const err = validateUrl('http://[fd12:3456:7890::1]/')
      expect(err).toContain('blocked')
    })
  })

  describe('invalid URLs', () => {
    it('rejects completely malformed URL', () => {
      const err = validateUrl('not-a-url')
      expect(err).toContain('Invalid URL')
    })

    it('rejects empty string', () => {
      const err = validateUrl('')
      expect(err).toContain('Invalid URL')
    })
  })
})
