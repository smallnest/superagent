import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TimerStore, type Timer } from '../src/infra/timers.ts'

describe('durable timers store', () => {
  it('saves, lists, and processes due timers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'superagent-timers-test-'))
    try {
      const store = new TimerStore(dir)

      const t1: Timer = {
        id: 'followup-1',
        kind: 'followup',
        ticketId: 'ticket-101',
        dueAt: '2026-11-15T10:00:00Z',
        prompt: 'Check CI status for ticket-101',
        createdAt: '2026-11-15T09:45:00Z',
      }

      const t2: Timer = {
        id: 'schedule-daily',
        kind: 'schedule',
        intervalMinutes: 60,
        dueAt: '2026-11-15T12:00:00Z',
        prompt: 'Hourly repo hygiene check',
        createdAt: '2026-11-15T09:00:00Z',
      }

      await store.save(t1)
      await store.save(t2)

      const all = await store.list()
      expect(all).toHaveLength(2)
      expect(all[0]?.id).toBe('followup-1')

      // Query due timers at 10:30
      const due = await store.getDue(new Date('2026-11-15T10:30:00Z'))
      expect(due).toHaveLength(1)
      expect(due[0]?.id).toBe('followup-1')

      // Process due: one-shot followup should be removed
      await store.processDue(due[0]!, new Date('2026-11-15T10:30:00Z'))
      const remaining = await store.list()
      expect(remaining).toHaveLength(1)
      expect(remaining[0]?.id).toBe('schedule-daily')

      // Process schedule timer at 12:05: should advance dueAt
      const due2 = await store.getDue(new Date('2026-11-15T12:05:00Z'))
      expect(due2).toHaveLength(1)
      await store.processDue(due2[0]!, new Date('2026-11-15T12:05:00Z'))

      const afterSchedule = await store.list()
      expect(afterSchedule).toHaveLength(1)
      expect(afterSchedule[0]?.dueAt).toBe('2026-11-15T13:05:00.000Z')
      expect(afterSchedule[0]?.lastRunAt).toBe('2026-11-15T12:05:00.000Z')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
