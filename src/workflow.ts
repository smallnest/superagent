/**
 * The issue-by-issue workflow: one labeled GitLab issue is proposed at a time, the operator is asked in a Feishu direct
 * message, the work runs only after a yes, and the issue is closed only after a second yes.
 *
 * The record of each issue lives in the state directory, so a restart re-asks nothing and a process that exits between
 * the question and the answer does not lose it.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './infra/commands.ts'

export type Phase = 'waiting' | 'working' | 'closing' | 'done' | 'skipped'

export interface IssueRecord {
  iid: number
  ticketId?: string
  phase: Phase
  at: string
}

/** One file per issue under `state/workflow`, so a person can read the queue with `ls` and `cat`. */
export class WorkflowStore {
  constructor(private readonly stateDir: string) {}

  private dir(): string { return join(this.stateDir, 'workflow') }
  private path(iid: number): string { return join(this.dir(), `${iid}.json`) }

  async init(): Promise<void> { await mkdir(this.dir(), { recursive: true }) }

  async get(iid: number): Promise<IssueRecord | undefined> {
    try { return JSON.parse(await readFile(this.path(iid), 'utf8')) as IssueRecord } catch { return undefined }
  }

  async save(record: IssueRecord): Promise<void> {
    await this.init()
    await writeFile(this.path(record.iid), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  }

  async all(): Promise<IssueRecord[]> {
    const names = await readdir(this.dir()).catch(() => [] as string[])
    const records: IssueRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try { records.push(JSON.parse(await readFile(join(this.dir(), name), 'utf8')) as IssueRecord) } catch { /* a half-written file is not a record */ }
    }
    return records
  }

  /** The issue the workflow is on: waiting for a yes, running, or waiting for a close. */
  async active(): Promise<IssueRecord | undefined> {
    return (await this.all()).find(record => record.phase === 'waiting' || record.phase === 'working' || record.phase === 'closing')
  }
}

export interface Command { verb: 'do' | 'skip' | 'close' | 'keep'; iid: number }

const VERBS: Record<string, Command['verb']> = { '做': 'do', '不做': 'skip', '关闭': 'close', '保留': 'keep' }

/** Reads `做 #2585`, `不做 #2585`, `关闭 #2585` or `保留 #2585`; anything else is a person's message as usual. */
export function workflowCommand(text: string): Command | undefined {
  const match = /^\s*(做|不做|关闭|保留)\s*#?\s*(\d+)\s*$/.exec(text)
  if (!match) return undefined
  const verb = VERBS[match[1]!]
  const iid = Number(match[2])
  return verb && Number.isInteger(iid) && iid > 0 ? { verb, iid } : undefined
}

/** Reads `记住 #2585 <one rule>`; the rule is kept and loaded into every later ticket's prompt. */
export function memoryCommand(text: string): { iid: number; text: string } | undefined {
  const match = /^\s*记住\s*#?\s*(\d+)\s+(.+)$/.exec(text)
  const iid = Number(match?.[1])
  const body = match?.[2]?.trim()
  return match && Number.isInteger(iid) && iid > 0 && body ? { iid, text: body } : undefined
}

/**
 * The installation's memory: short rules a person wrote with `记住 #<iid> <text>`, loaded into every later ticket.
 *
 * The file is plain markdown a person can read and edit. A rule is one line, an identical line is not written twice, and
 * the oldest lines go when the list passes its cap: a list that grows forever turns back into a transcript.
 */
export class MemoryStore {
  constructor(private readonly stateDir: string) {}

  /** The rules file, which a review step names so a person can edit it. */
  file(): string { return join(this.dir(), 'rules.md') }
  private dir(): string { return join(this.stateDir, 'memory') }
  private reviewPath(): string { return join(this.dir(), 'reviewed.json') }

  async rules(): Promise<string[]> {
    const text = await readFile(this.file(), 'utf8').catch(() => '')
    return text.split('\n').map(line => line.trim()).filter(line => line.startsWith('- '))
  }

  /** Adds one rule, dated; the newest `maxLines` are kept. Returns the rules as stored. */
  async remember(line: string, maxLines: number, at = new Date()): Promise<string[]> {
    await mkdir(this.dir(), { recursive: true })
    const entry = `- ${at.toISOString().slice(0, 10)} ${line.replace(/\s+/g, ' ').trim()}`
    const existing = await this.rules()
    const next = (existing.includes(entry) ? existing : [...existing, entry]).slice(-maxLines)
    await writeFile(this.file(), `${next.join('\n')}\n`, 'utf8')
    return next
  }

  /** True when the rules have not been read back by a person for `days`. */
  async dueForReview(days: number): Promise<boolean> {
    try {
      const { at } = JSON.parse(await readFile(this.reviewPath(), 'utf8')) as { at: string }
      return Date.now() - Date.parse(at) >= days * 86_400_000
    } catch { return true }
  }

  async markReviewed(at = new Date()): Promise<void> {
    await mkdir(this.dir(), { recursive: true })
    await writeFile(this.reviewPath(), JSON.stringify({ at: at.toISOString() }), 'utf8')
  }
}

/** The next issue to propose: the oldest one not yet proposed. Dependencies are lower-numbered, so they come first. */
export function nextIssue<T extends { iid: number }>(issues: readonly T[], seen: ReadonlySet<number>): T | undefined {
  return [...issues]
    .filter(issue => !seen.has(issue.iid))
    .sort((a, b) => a.iid - b.iid)[0]
}

/**
 * Runs the configured checks in the ticket's worktree and returns a short markdown record.
 *
 * A failing command is recorded, not thrown: the report still reaches the operator, and the summary says what failed.
 */
export async function runChecks(commands: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const lines: string[] = []
  for (const command of commands) {
    try {
      const output = await run('/bin/sh', ['-c', command], { cwd, signal, timeoutMs: 30 * 60_000 })
      lines.push(`- \`${command}\`: ok`)
      const tail = output.trim().split('\n').slice(-6).join('\n')
      if (tail) lines.push('', '```', tail, '```')
    } catch (error) {
      lines.push(`- \`${command}\`: FAILED — ${(error as Error).message.split('\n')[0]!.slice(0, 300)}`)
    }
  }
  return lines.join('\n')
}
