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

/** The next issue to propose: the Phase 0 issue first, then the lowest iid not yet proposed. */
export function nextIssue<T extends { iid: number; title: string }>(issues: readonly T[], seen: ReadonlySet<number>): T | undefined {
  const rank = (issue: T): number => (/^\[Phase 0\]/.test(issue.title) ? 0 : 1)
  return [...issues]
    .filter(issue => !seen.has(issue.iid))
    .sort((a, b) => rank(a) - rank(b) || a.iid - b.iid)[0]
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
