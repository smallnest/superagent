/**
 * Executes local automated verification commands (e.g. test suites, linters, build scripts)
 * inside a PR's checked-out worktree before code review.
 */
import { run } from './commands.ts'

export interface CommandExecutionResult {
  command: string
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
  passed: boolean
}

export interface PrVerificationSummary {
  passed: boolean
  totalCommands: number
  results: CommandExecutionResult[]
  markdown: string
}

export async function runPrVerification(options: {
  cwd: string
  commands: string[]
  timeoutSeconds?: number
  env?: Record<string, string>
  signal?: AbortSignal
}): Promise<PrVerificationSummary> {
  const results: CommandExecutionResult[] = []
  let allPassed = true
  const timeoutMs = (options.timeoutSeconds ?? 300) * 1000

  for (const cmd of options.commands) {
    const start = Date.now()
    try {
      const output = await run('/bin/sh', ['-c', cmd], {
        cwd: options.cwd,
        env: options.env,
        timeoutMs,
        signal: options.signal,
      })
      const durationMs = Date.now() - start
      results.push({
        command: cmd,
        exitCode: 0,
        durationMs,
        stdout: output,
        stderr: '',
        passed: true,
      })
    } catch (err: any) {
      const durationMs = Date.now() - start
      allPassed = false
      results.push({
        command: cmd,
        exitCode: err.exitCode ?? 1,
        durationMs,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? '',
        passed: false,
      })
      // Stop on first failed verification command
      break
    }
  }

  // Generate markdown report
  const lines: string[] = [
    '### Automated Local Verification',
    '',
    allPassed
      ? '✅ **All local verification checks passed.**'
      : '❌ **Local verification failed.** The code in this PR failed one or more verification commands.',
    '',
    '| Command | Status | Duration |',
    '| :--- | :--- | :--- |',
  ]

  for (const r of results) {
    lines.push(`| \`${r.command}\` | ${r.passed ? '✅ PASS' : '❌ FAIL (exit ' + r.exitCode + ')'} | ${(r.durationMs / 1000).toFixed(1)}s |`)
  }

  for (const r of results) {
    if (!r.passed) {
      lines.push('', `#### Failure Log: \`${r.command}\``, '```text', (r.stderr || r.stdout || 'Unknown error').trim().slice(-3000), '```')
    }
  }

  return {
    passed: allPassed,
    totalCommands: options.commands.length,
    results,
    markdown: lines.join('\n'),
  }
}
