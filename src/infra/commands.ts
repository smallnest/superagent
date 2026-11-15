/** Runs the Source CLIs (`gh`, `lark-cli`) and reads their JSON. Every call is bounded and never prompts. */
import { execFile } from 'node:child_process'

export interface RunOptions {
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  signal?: AbortSignal | undefined
  stdin?: string | undefined
  timeoutMs?: number | undefined
}

export class CliError extends Error {
  constructor(program: string, message: string, readonly stdout: string, readonly stderr: string) {
    super(message)
    this.name = 'CliError'
  }
}

/** Runs a program and returns its standard output; a non-zero exit throws a `CliError` that keeps both streams. */
export function run(program: string, argv: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(program, argv, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 64 << 20,
      ...options.signal ? { signal: options.signal } : {},
    }, (error, stdout, stderr) => {
      if (error) reject(new CliError(program, `${program} ${argv.join(' ')} failed: ${stderr.trim() || error.message}`, stdout, stderr))
      else resolve(stdout)
    })
    if (options.stdin !== undefined) child.stdin?.end(options.stdin)
    else child.stdin?.end()
  })
}

/** Runs a program and parses its JSON output; accepts the plain shape and the `{ok, data}` envelope `lark-cli` uses. */
export async function runJson<T>(program: string, argv: string[], options: RunOptions = {}): Promise<T> {
  const text = await run(program, argv, options)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new CliError(program, `${program} ${argv.join(' ')} did not print JSON: ${text.slice(0, 200)}`, text, '') }
  if (parsed && typeof parsed === 'object' && 'ok' in parsed && (parsed as { ok: unknown }).ok === false) {
    const error = (parsed as { error?: { message?: string } }).error
    throw new CliError(program, `${program} ${argv.join(' ')}: ${error?.message ?? 'failed'}`, text, '')
  }
  // `lark-cli` and `opencli` answer with `{code, data}` or `{ok, data}` envelopes; `gh api` never does.
  if (parsed && typeof parsed === 'object' && ('code' in parsed || 'ok' in parsed) && 'data' in parsed) return (parsed as { data: T }).data
  return parsed as T
}
