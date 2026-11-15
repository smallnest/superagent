import { describe, expect, it } from 'vitest'
import { isQuietHours, isUserPresent } from '../src/infra/presence.ts'

describe('presence detection and attention budget', () => {
  describe('quiet hours calculation', () => {
    it('returns false when disabled', () => {
      const config = { enabled: false, start: '23:00', end: '08:00' }
      const now = new Date('2026-11-15T02:00:00')
      expect(isQuietHours(now, config)).toBe(false)
    })

    it('identifies quiet hours crossing midnight', () => {
      const config = { enabled: true, start: '23:00', end: '08:00' }
      expect(isQuietHours(new Date('2026-11-15T23:30:00'), config)).toBe(true)
      expect(isQuietHours(new Date('2026-11-15T03:15:00'), config)).toBe(true)
      expect(isQuietHours(new Date('2026-11-15T07:59:00'), config)).toBe(true)
      expect(isQuietHours(new Date('2026-11-15T08:00:00'), config)).toBe(false)
      expect(isQuietHours(new Date('2026-11-15T14:00:00'), config)).toBe(false)
      expect(isQuietHours(new Date('2026-11-15T22:59:00'), config)).toBe(false)
    })

    it('identifies quiet hours within same day', () => {
      const config = { enabled: true, start: '13:00', end: '14:00' }
      expect(isQuietHours(new Date('2026-11-15T13:30:00'), config)).toBe(true)
      expect(isQuietHours(new Date('2026-11-15T12:59:00'), config)).toBe(false)
      expect(isQuietHours(new Date('2026-11-15T14:01:00'), config)).toBe(false)
    })
  })

  describe('user presence evaluation', () => {
    it('considers user present when idle time is less than threshold', async () => {
      const mockIdle = async () => 60 // 1 minute idle
      expect(await isUserPresent(300, mockIdle)).toBe(true)
    })

    it('considers user absent when idle time exceeds threshold', async () => {
      const mockIdle = async () => 600 // 10 minutes idle
      expect(await isUserPresent(300, mockIdle)).toBe(false)
    })

    it('handles provider errors by treating user as absent', async () => {
      const mockIdle = async () => { throw new Error('Cannot query idle') }
      expect(await isUserPresent(300, mockIdle)).toBe(false)
    })
  })
})
