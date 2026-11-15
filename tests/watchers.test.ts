import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatcherEngine, type WatcherConfig } from '../src/infra/watchers.ts'

describe('active watchers engine', () => {
  it('records baseline on initial check, and triggers when output changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'superagent-watchers-test-'))
    try {
      const engine = new WatcherEngine(dir)
      const watcher: WatcherConfig = {
        id: 'watch-issues',
        intervalMinutes: 10,
        command: 'gh issue list',
        instruction: 'Review newly opened issues',
      }

      let mockOutput = 'Issue #1: Bug in parser'
      const runner = async () => mockOutput

      // 1. First run records baseline, not triggered
      const res1 = await engine.check(watcher, { now: new Date('2026-11-15T10:00:00Z'), runner })
      expect(res1.triggered).toBe(false)

      // 2. Not due yet (only 5 minutes later)
      const res2 = await engine.check(watcher, { now: new Date('2026-11-15T10:05:00Z'), runner })
      expect(res2.triggered).toBe(false)

      // 3. Due (11 minutes later), but output unchanged
      const res3 = await engine.check(watcher, { now: new Date('2026-11-15T10:11:00Z'), runner })
      expect(res3.triggered).toBe(false)

      // 4. Due (25 minutes later), and output changed!
      mockOutput = 'Issue #1: Bug in parser\nIssue #2: Support quiet hours'
      const res4 = await engine.check(watcher, { now: new Date('2026-11-15T10:25:00Z'), runner })
      expect(res4.triggered).toBe(true)
      expect(res4.diffText).toContain('Support quiet hours')
      expect(res4.diffText).toContain('Review newly opened issues')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
