/**
 * Token and autonomous wakeup budget guard.
 *
 * Implements the "Waking up costs real money" principle from Anthropic's "Building always-on agents"
 * and FanBox practice: enforces a minimum cooldown between autonomous wakeups and a daily wakeup cap
 * to protect the user's budget and API quotas from runaway background executions.
 */

export interface BudgetConfig {
  autonomousCooldownSeconds: number
  maxAutonomousWakesPerDay: number
}

export interface BudgetState {
  date: string // YYYY-MM-DD
  autonomousWakes: number
  lastWakeAt?: string // ISO timestamp
}

export interface BudgetStorage {
  get(): Promise<BudgetState | undefined> | BudgetState | undefined
  set(state: BudgetState): Promise<void> | void
}

export class BudgetGuard {
  constructor(
    private readonly config: BudgetConfig,
    private readonly storage: BudgetStorage,
  ) {}

  /** Checks if an autonomous wakeup is currently permitted under budget rules. */
  async check(now = new Date()): Promise<{ allowed: boolean; reason?: string }> {
    const today = now.toISOString().slice(0, 10)
    const current = (await this.storage.get()) ?? { date: today, autonomousWakes: 0 }
    const state: BudgetState = current.date === today ? current : { date: today, autonomousWakes: 0 }

    // Check 1: Daily limit
    if (state.autonomousWakes >= this.config.maxAutonomousWakesPerDay) {
      return {
        allowed: false,
        reason: `Daily autonomous limit reached (${state.autonomousWakes}/${this.config.maxAutonomousWakesPerDay})`,
      }
    }

    // Check 2: Cooldown between consecutive autonomous wakeups
    if (state.lastWakeAt && this.config.autonomousCooldownSeconds > 0) {
      const elapsedSeconds = Math.floor((now.getTime() - new Date(state.lastWakeAt).getTime()) / 1000)
      if (elapsedSeconds < this.config.autonomousCooldownSeconds) {
        const waitLeft = this.config.autonomousCooldownSeconds - elapsedSeconds
        return {
          allowed: false,
          reason: `Autonomous cooldown active (${waitLeft}s remaining of ${this.config.autonomousCooldownSeconds}s)`,
        }
      }
    }

    return { allowed: true }
  }

  /** Records that an autonomous wakeup has occurred, incrementing counter and recording timestamp. */
  async record(now = new Date()): Promise<BudgetState> {
    const today = now.toISOString().slice(0, 10)
    const current = (await this.storage.get()) ?? { date: today, autonomousWakes: 0 }
    const state: BudgetState = current.date === today ? { ...current } : { date: today, autonomousWakes: 0 }
    state.autonomousWakes += 1
    state.lastWakeAt = now.toISOString()
    await this.storage.set(state)
    return state
  }
}
