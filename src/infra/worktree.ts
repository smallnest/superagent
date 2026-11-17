/**
 * Gives a ticket its own git worktree and branch, so two tickets can change one repository at once and neither sees the
 * other's half-finished edits.
 *
 * A worktree rather than a clone: it shares the checkout's object store, so it costs a directory and nothing else. The
 * worktree lives under `stateDir/work/<ticket>`, which is also where the agent's run log goes.
 *
 * A checkout that is not a git repository gets a plain directory instead. That keeps `superagent run` and installations
 * that watch nothing but a chat working.
 */
import { access, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './commands.ts'

/** A short, git-safe branch name for a ticket: a slug of its title, made unique by the ticket's id. */
export function ticketBranch(prefix: string, title: string, id: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')
  return `${prefix}${slug || 'request'}-${id.slice(-6)}`
}

/** Whether `directory` is inside a git work tree. */
async function isGitRepository(directory: string): Promise<boolean> {
  try { await access(join(directory, '.git')); return true } catch { /* a worktree root holds `.git` as a file, a checkout as a directory */ }
  try {
    await run('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 10_000 })
    return true
  } catch { return false }
}

export interface PrepareWorktreeOptions {
  checkout: string
  directory: string
  branch: string
  prNumber?: number
  repository?: string
  /** The ref holding the review's head, such as `pull/42/head` or `refs/merge-requests/42/head`. */
  ref?: string
  /** The URL to fetch the ref from when the checkout's `origin` is not the forge's repository. */
  remote?: string
  signal?: AbortSignal
}

/**
 * Creates the worktree for a ticket and returns its directory.
 * When `prNumber` is specified, fetches the review's head and checks it out directly into the worktree.
 *
 * @throws when git cannot create the worktree, such as when the checkout has no commit yet; the caller then reports the
 * ticket as failed instead of starting an agent in a directory that is not the repository.
 */
export async function prepareWorktree(options: PrepareWorktreeOptions): Promise<string> {
  const { checkout, directory, branch, prNumber, repository, signal } = options
  await mkdir(directory, { recursive: true })
  if ((await readdir(directory)).length) return directory
  if (!await isGitRepository(checkout)) return directory

  if (prNumber) {
    const head = options.ref ?? `pull/${prNumber}/head`
    const remote = options.remote ?? (repository ? `https://github.com/${repository}.git` : undefined)
    let fetched = false
    try {
      await run('git', ['-C', checkout, 'fetch', 'origin', `${head}:${branch}`], { signal, timeoutMs: 60_000 })
      fetched = true
    } catch {
      if (remote) {
        try {
          await run('git', ['-C', checkout, 'fetch', remote, `${head}:${branch}`], { signal, timeoutMs: 60_000 })
          fetched = true
        } catch { /* fallback to base HEAD */ }
      }
    }
    if (fetched) {
      await run('git', ['-C', checkout, 'worktree', 'add', directory, branch], { signal, timeoutMs: 120_000 })
        .catch(async error => {
          await removeWorktree(checkout, directory, signal, branch)
          throw new Error(`${directory} is not a branch point for review #${prNumber}: ${(error as Error).message}`, { cause: error })
        })
      return directory
    }
  }

  // The base is named first, because `worktree add -b` refuses a detached HEAD and `switch` would then create an orphan branch.
  const base = (await run('git', ['-C', checkout, 'rev-parse', 'HEAD'], { signal, timeoutMs: 10_000 })).trim()
  await run('git', ['-C', checkout, 'worktree', 'add', '-b', branch, directory, base], { signal, timeoutMs: 120_000 })
    .catch(
      // Failing is the expected case here, so the stack is not worth printing.
      async error => { await removeWorktree(checkout, directory, signal, branch); throw new Error(`${directory} is not a branch point: ${(error as Error).message}`, { cause: error }) })
  return directory
}

/** Removes a ticket's worktree once its ticket ended, so the state directory does not grow without bound. */
export async function removeWorktree(checkout: string, directory: string, signal?: AbortSignal, branchToDelete?: string): Promise<void> {
  try { await run('git', ['-C', checkout, 'worktree', 'remove', '--force', directory], { signal, timeoutMs: 120_000 }) } catch { /* a directory that was never a worktree needs no removal */ }
  if (branchToDelete) {
    try { await run('git', ['-C', checkout, 'branch', '-D', branchToDelete], { signal, timeoutMs: 10_000 }) } catch { /* ignore */ }
  }
}
