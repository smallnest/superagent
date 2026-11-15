/** Runs a task on Codex CLI (`codex exec`), which prints JSONL events and can write its last message to a file. */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from './process.ts'
import { readReport, type AgentResult, type AgentRunner, type AgentRun } from './types.ts'

export class CodexRunner implements AgentRunner {
  readonly name = 'codex'
  constructor(private readonly binary = 'codex') {}

  async available(): Promise<boolean> {
    const result = await runProcess(this.binary, ['--version'], {
      cwd: process.cwd(), env: { ...process.env as Record<string, string> }, stdin: '', signal: AbortSignal.timeout(10_000),
    })
    return result.exitCode === 0
  }

  async run(run: AgentRun): Promise<AgentResult> {
    const lastMessage = join(run.cwd, '.superagent', 'codex-last-message.txt')
    const argv = [
      'exec',
      // Full access for human-explicit runs; read-only sandbox for autonomous runs.
      '--sandbox', run.readOnly ? 'read-only' : 'danger-full-access',
      '--skip-git-repo-check',
      // JSONL on stdout, so a later reader can reconstruct what happened.
      '--json',
      '-o', lastMessage,
      '-C', run.cwd,
      ...run.model ? ['-m', run.model] : [],
      '-',
    ]
    const result = await runProcess(this.binary, argv, { cwd: run.cwd, env: run.env, stdin: run.prompt, signal: run.signal, timeoutMs: run.timeoutMs })
    const finalText = await readFile(lastMessage, 'utf8').catch(() => '')
    await rm(lastMessage, { force: true })
    const report = await readReport(run.cwd)
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      finalText: finalText.trim() || lastAssistantMessage(result.stdout),
      ...report ? { report } : {},
      exitCode: result.exitCode,
      raw: result.stdout,
    }
  }
}

/** Reads the last `agent_message` item from a Codex JSONL stream, for when no last-message file was written. */
function lastAssistantMessage(stdout: string): string {
  let found = ''
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') found = event.item.text
    } catch { /* a partial line is not fatal */ }
  }
  return found
}
