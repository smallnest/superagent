import { describe, expect, it } from 'vitest'
import { BudgetGuard, type BudgetState } from '../src/infra/budget.ts'

describe('budget guard', () => {
  it('allows wakeup when within daily limit and no prior wakeup', async () => {
    let stored: BudgetState | undefined
    const guard = new BudgetGuard(
      { autonomousCooldownSeconds: 60, maxAutonomousWakesPerDay: 5 },
      { get: () => stored, set: (s) => { stored = s } },
    )

    const check = await guard.check(new Date('2026-11-15T10:00:00Z'))
    expect(check.allowed).toBe(true)
  })

  it('enforces cooldown between wakeups', async () => {
    let stored: BudgetState | undefined
    const guard = new BudgetGuard(
      { autonomousCooldownSeconds: 180, maxAutonomousWakesPerDay: 10 },
      { get: () => stored, set: (s) => { stored = s } },
    )

    const t0 = new Date('2026-11-15T10:00:00Z')
    await guard.record(t0)

    // 1 minute later (< 3 min cooldown)
    const t1 = new Date('2026-11-15T10:01:00Z')
    const check1 = await guard.check(t1)
    expect(check1.allowed).toBe(false)
    expect(check1.reason).toContain('Autonomous cooldown active')

    // 4 minutes later (> 3 min cooldown)
    const t2 = new Date('2026-11-15T10:04:00Z')
    const check2 = await guard.check(t2)
    expect(check2.allowed).toBe(true)
  })

  it('blocks wakeup when daily limit is exceeded', async () => {
    let stored: BudgetState | undefined
    const guard = new BudgetGuard(
      { autonomousCooldownSeconds: 0, maxAutonomousWakesPerDay: 2 },
      { get: () => stored, set: (s) => { stored = s } },
    )

    const today = new Date('2026-11-15T10:00:00Z')
    await guard.record(today)
    await guard.record(today)

    const check = await guard.check(today)
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('Daily autonomous limit reached (2/2)')

    // Next day resets count
    const tomorrow = new Date('2026-11-16T10:00:00Z')
    const checkTomorrow = await guard.check(tomorrow)
    expect(checkTomorrow.allowed).toBe(true)
  })
})
