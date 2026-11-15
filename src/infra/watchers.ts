/**
 * Active watchers ("盯梢") for pull-based external sources without webhooks.
 *
 * Implements the "Not all events push themselves" lesson from FanBox and Anthropic:
 * Periodically executes a lightweight command (e.g. `gh pr list`, `git fetch`), compares the output fingerprint,
 * and produces a synthetic trigger only when new lines or status changes occur.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './commands.ts'

export interface WatcherConfig {
  id: string
  intervalMinutes: number
  command: string
  instruction: string
}

export interface WatcherState {
  id: string
  lastRunAt: string
  lastOutputHash: string
  lastOutputPreview: string
}

export interface WatcherCheckResult {
  triggered: boolean
  diffText?: string
  error?: string
}

export class WatcherEngine {
  constructor(private readonly dir: string) {}

  private watchersDir(): string {
    return join(this.dir, 'watchers')
  }

  async init(): Promise<void> {
    await mkdir(this.watchersDir(), { recursive: true })
  }

  async getState(id: string): Promise<WatcherState | undefined> {
    await this.init()
    try {
      const raw = await readFile(join(this.watchersDir(), `${id}.json`), 'utf8')
      return JSON.parse(raw) as WatcherState
    } catch {
      return undefined
    }
  }

  async saveState(state: WatcherState): Promise<void> {
    await this.init()
    await writeFile(join(this.watchersDir(), `${state.id}.json`), JSON.stringify(state, null, 2), 'utf8')
  }

  /**
   * Checks whether the watcher is due for execution.
   */
  isDue(watcher: WatcherConfig, state?: WatcherState, now = new Date()): boolean {
    if (!state?.lastRunAt) return true
    const elapsedMinutes = (now.getTime() - new Date(state.lastRunAt).getTime()) / 60_000
    return elapsedMinutes >= watcher.intervalMinutes
  }

  /**
   * Runs the watcher command, checks for output changes, and updates persistent state.
   */
  async check(
    watcher: WatcherConfig,
    options: {
      now?: Date
      runner?: (cmd: string) => Promise<string>
    } = {},
  ): Promise<WatcherCheckResult> {
    const now = options.now ?? new Date()
    const runner = options.runner ?? (async (cmd) => run('/bin/sh', ['-c', cmd], { timeoutMs: 30_000 }))

    const state = await this.getState(watcher.id)
    if (!this.isDue(watcher, state, now)) {
      return { triggered: false }
    }

    let output = ''
    try {
      output = await runner(watcher.command)
    } catch (error) {
      return { triggered: false, error: (error as Error).message }
    }

    const trimmed = output.trim()
    const hash = createHash('sha256').update(trimmed).digest('hex')

    // Initial run: record baseline without spamming
    if (!state) {
      await this.saveState({
        id: watcher.id,
        lastRunAt: now.toISOString(),
        lastOutputHash: hash,
        lastOutputPreview: trimmed.slice(0, 500),
      })
      return { triggered: false }
    }

    // Output unchanged
    if (state.lastOutputHash === hash) {
      await this.saveState({
        ...state,
        lastRunAt: now.toISOString(),
      })
      return { triggered: false }
    }

    // Output changed! Compute diff preview
    const diff = `Watcher "${watcher.id}" detected change in command output:\n\n${trimmed.slice(0, 2000)}\n\nInstruction: ${watcher.instruction}`
    await this.saveState({
      id: watcher.id,
      lastRunAt: now.toISOString(),
      lastOutputHash: hash,
      lastOutputPreview: trimmed.slice(0, 500),
    })

    return { triggered: true, diffText: diff }
  }
}
