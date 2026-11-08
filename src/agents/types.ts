/**
 * The output every runner must produce.
 *
 * A coding agent has no structured tool channel when it runs as a subprocess, so the report is a convention instead: the
 * agent writes it to `REPORT_FILE` in its working directory before it stops. Every runner reads that one file, which keeps
 * the contract identical across agents and needs no per-agent parsing.
 */

export const REPORT_FILE = '.superagent/report.json'
export const LOG_DIR = '.superagent'

/** What the agent reports back. Every field but `summary` is optional so a partial report still delivers. */
export interface AgentReport {
  /** One short sentence a person can act on. The only field the delivery uses verbatim. */
  summary: string
  /** `ready` when the work is ready for review, `blocked` when a person must act, `failed` when it cannot finish. */
  state?: 'ready' | 'blocked' | 'failed'
  /** Pull request URLs the work produced. */
  prs?: string[]
  /** A question when `state` is `blocked`, naming what the person must supply. */
  question?: string
  /** Anything else the agent wants on the record. */
  notes?: string
}

export interface AgentRun {
  /** The full prompt, already composed for this agent. */
  prompt: string
  /** The directory the agent works in, which is also its working directory. */
  cwd: string
  /** Environment for the process: the account shims and the run's variables. */
  env: Record<string, string>
  signal: AbortSignal
  timeoutMs?: number
  /** Overrides the configured model, such as a per-ticket choice. */
  model?: string | undefined
}

export interface AgentResult {
  ok: boolean
  /** The agent's last message, used when it wrote no report. */
  finalText: string
  /** The parsed report, when the agent wrote one. */
  report?: AgentReport
  /** The process exit code. */
  exitCode: number
  /** Raw events or output, kept for diagnosis. */
  raw: string
  /** Where the full log was written, when the runner wrote one. */
  logPath?: string
}

export interface AgentRunner {
  /** The name a configuration uses to select this runner, such as `codex`. */
  readonly name: string
  /** Whether the agent's CLI is on PATH and answers a version query. */
  available(): Promise<boolean>
  run(run: AgentRun): Promise<AgentResult>
}

/** Reads the report an agent left, or `undefined` when it wrote none or wrote an unusable one. */
export async function readReport(cwd: string): Promise<AgentReport | undefined> {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  try {
    const parsed = JSON.parse(await readFile(join(cwd, REPORT_FILE), 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string' && parsed.summary.trim()) return parsed as AgentReport
    return undefined
  } catch { return undefined }
}

/** Instructions that tell an agent to write the report, appended to every composed prompt. */
export function reportInstructions(): string {
  return [
    '',
    '## Report',
    '',
    `Before you stop, write \`${REPORT_FILE}\` in your working directory as one JSON object with these keys:`,
    '',
    '- `summary` (required): one short sentence a person can act on, under 200 characters. It is the reply the person sees,',
    '  so leave file names, test counts and other evidence out of it; put that in your pull request or your last message.',
    '- `state`: `ready` when the work is ready for review, `blocked` when a person must supply something, `failed` when it cannot finish.',
    '- `prs`: the pull request URLs you opened, when any.',
    '- `question`: what the person must supply, when `state` is `blocked`.',
    '',
    'Write nothing else to that file. If you cannot write it, say the same in your last message.',
  ].join('\n')
}
