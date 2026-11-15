/** Runs a task on Claude Code (`claude -p`), which prints a stream-json transcript. */
import { runProcess } from './process.ts'
import { readReport, type AgentResult, type AgentRunner, type AgentRun } from './types.ts'

export class ClaudeRunner implements AgentRunner {
  readonly name = 'claude'
  constructor(private readonly binary = 'claude') {}

  async available(): Promise<boolean> {
    const result = await runProcess(this.binary, ['--version'], {
      cwd: process.cwd(), env: { ...process.env as Record<string, string> }, stdin: '', signal: AbortSignal.timeout(10_000),
    })
    return result.exitCode === 0
  }

  async run(run: AgentRun): Promise<AgentResult> {
    const argv = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      // Autonomous runs are restricted to read-only tools; human-explicit runs get full permissions.
      ...run.readOnly ? ['--tools', 'Read,Grep,Glob'] : ['--dangerously-skip-permissions'],
      ...run.model ? ['--model', run.model] : [],
    ]
    const result = await runProcess(this.binary, argv, { cwd: run.cwd, env: run.env, stdin: run.prompt, signal: run.signal, timeoutMs: run.timeoutMs })
    const report = await readReport(run.cwd)
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      finalText: lastResultText(result.stdout),
      ...report ? { report } : {},
      exitCode: result.exitCode,
      raw: result.stdout,
    }
  }
}

/** Reads the final `result` event's text, or the last assistant message, from a Claude stream-json transcript. */
function lastResultText(stdout: string): string {
  let last = ''
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as { type?: string; result?: unknown; message?: { content?: Array<{ type?: string; text?: string }> } }
      if (event.type === 'result' && typeof event.result === 'string') last = event.result
      else if (event.type === 'assistant') {
        const text = event.message?.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('')
        if (text) last = text
      }
    } catch { /* a partial line is not fatal */ }
  }
  return last
}
