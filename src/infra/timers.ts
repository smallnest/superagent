/**
 * Durable timers engine for proactive and autonomous agent runs.
 *
 * Implements the "Timers" primitive from Anthropic's "Building always-on agents":
 * 1) Follow-ups: Short-term checkpoints scheduled by the agent or tickets (e.g. check CI in 15m).
 * 2) Schedules: Recurring cron/interval-based jobs (e.g. daily standup, repo hygiene).
 *
 * Expired timers generate synthetic events for the Event Inbox, allowing the agent to sleep between runs.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Timer {
  id: string
  kind: 'followup' | 'schedule'
  dueAt: string // ISO timestamp
  ticketId?: string
  cron?: string
  intervalMinutes?: number
  prompt: string
  createdAt: string
  lastRunAt?: string
}

export class TimerStore {
  constructor(private readonly dir: string) {}

  private timersDir(): string {
    return join(this.dir, 'timers')
  }

  async init(): Promise<void> {
    await mkdir(this.timersDir(), { recursive: true })
  }

  async list(): Promise<Timer[]> {
    await this.init()
    const entries = await readdir(this.timersDir()).catch(() => [])
    const timers: Timer[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const raw = await readFile(join(this.timersDir(), entry), 'utf8')
        timers.push(JSON.parse(raw) as Timer)
      } catch { /* skip corrupted file */ }
    }
    return timers.sort((a, b) => a.dueAt.localeCompare(b.dueAt))
  }

  async save(timer: Timer): Promise<void> {
    await this.init()
    const path = join(this.timersDir(), `${timer.id}.json`)
    await writeFile(path, JSON.stringify(timer, null, 2), 'utf8')
  }

  async remove(id: string): Promise<void> {
    await this.init()
    await rm(join(this.timersDir(), `${id}.json`), { force: true })
  }

  async getDue(now = new Date()): Promise<Timer[]> {
    const all = await this.list()
    const nowIso = now.toISOString()
    return all.filter(timer => timer.dueAt <= nowIso)
  }

  /**
   * Advances a recurring schedule timer or removes a one-shot follow-up timer.
   */
  async processDue(timer: Timer, now = new Date()): Promise<void> {
    if (timer.kind === 'schedule' && timer.intervalMinutes && timer.intervalMinutes > 0) {
      const nextDue = new Date(now.getTime() + timer.intervalMinutes * 60_000).toISOString()
      const updated: Timer = {
        ...timer,
        dueAt: nextDue,
        lastRunAt: now.toISOString(),
      }
      await this.save(updated)
    } else {
      // One-shot timer: clean up after firing
      await this.remove(timer.id)
    }
  }
}
