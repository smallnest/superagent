/**
 * Gives a ticket its own git worktree and branch, so two tickets can change one repository at once and neither sees the
 * other's half-finished edits.
 *
 * A worktree rather than a clone: it shares the checkout's object store, so it costs a directory and nothing else. The
 * worktree lives under `stateDir/work/<ticket>`, and the ticket's run log lives in `stateDir/tickets/<ticket>/log.md`, so
 * removing the worktree never removes the only record of what happened.
 *
 * A checkout that is not a git repository gets a plain directory instead. That keeps `superagent run` and installations
 * that watch nothing but a chat working.
 */
import { access, copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
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

const exists = async (path: string): Promise<boolean> => { try { await stat(path); return true } catch { return false } }

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

/** What a ticket's directory is: its branch's base commit, or a review checkout whose branch belongs to someone else. */
export interface PreparedWorktree {
  directory: string
  /** The commit the ticket's branch was cut from, so cleanup knows which commits the ticket added. */
  base?: string
  /** True for a review checkout: the branch is the request's head, not the ticket's work, and must never be pushed. */
  review: boolean
}

/**
 * Creates the worktree for a ticket and describes it.
 * When `prNumber` is specified, fetches the review's head and checks it out directly into the worktree.
 *
 * @throws when git cannot create the worktree, such as when the checkout has no commit yet; the caller then reports the
 * ticket as failed instead of starting an agent in a directory that is not the repository.
 */
export async function prepareWorktree(options: PrepareWorktreeOptions): Promise<PreparedWorktree> {
  const { checkout, directory, branch, prNumber, repository, signal } = options
  await mkdir(directory, { recursive: true })
  // A directory that already holds a turn, such as one a restart continues, keeps the branch and base it was made with.
  if ((await readdir(directory)).length) return { directory, review: Boolean(prNumber) }
  if (!await isGitRepository(checkout)) return { directory, review: Boolean(prNumber) }

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
      return { directory, review: true }
    }
  }

  // The base is named first, because `worktree add -b` refuses a detached HEAD and `switch` would then create an orphan branch.
  const base = (await run('git', ['-C', checkout, 'rev-parse', 'HEAD'], { signal, timeoutMs: 10_000 })).trim()
  await run('git', ['-C', checkout, 'worktree', 'add', '-b', branch, directory, base], { signal, timeoutMs: 120_000 })
    .catch(
      // Failing is the expected case here, so the stack is not worth printing.
      async error => { await removeWorktree(checkout, directory, signal, branch); throw new Error(`${directory} is not a branch point: ${(error as Error).message}`, { cause: error }) })
  return { directory, base, review: false }
}

/**
 * Removes a worktree and the branch that was checked out in it.
 *
 * A plain directory, such as one an installation without git uses, is removed in the same step. Failures are ignored here;
 * `cleanupWorktree` is where a ticket's end decides whether removal succeeded.
 */
export async function removeWorktree(checkout: string, directory: string, signal?: AbortSignal, branchToDelete?: string): Promise<void> {
  try { await run('git', ['-C', checkout, 'worktree', 'remove', '--force', directory], { signal, timeoutMs: 120_000 }) } catch { /* a directory that was never a worktree needs no removal */ }
  try { await run('git', ['-C', checkout, 'worktree', 'prune'], { signal, timeoutMs: 30_000 }) } catch { /* a checkout without git has nothing to prune */ }
  if (branchToDelete) {
    try { await run('git', ['-C', checkout, 'branch', '-D', branchToDelete], { signal, timeoutMs: 10_000 }) } catch { /* ignore */ }
  }
}

export interface CleanupWorktreeOptions {
  checkout: string
  stateDir: string
  ticketId: string
  directory: string
  /** The ticket's branch; absent when no branch was ever created. */
  branch?: string | undefined
  /** The commit the branch was cut from, when the worktree recorded it. */
  base?: string | undefined
  /** True for a review checkout, whose branch belongs to the request's author and must not be pushed. */
  review?: boolean | undefined
  /** The worker's environment, so a push uses the agent's credentials rather than the operator's. */
  env?: Record<string, string> | undefined
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
}

/** What cleanup did: remove the worktree, push the branch first, or skip a directory that is not a ticket worktree. */
export interface CleanupWorktreeResult { removed: boolean; pushed: boolean; skipped?: 'outsideState' }

/**
 * Removes a ticket's worktree without losing the work that only it holds.
 *
 * 1. An uncommitted change is saved as `stateDir/tickets/<ticket>/worktree.patch`, because the worktree is about to go.
 * 2. The branch's commits are pushed to `origin` when the remote does not already have them; a review checkout is never
 *    pushed. A push failure throws, and the caller keeps the worktree so the next round can try again.
 * 3. A log left in the worktree by an older version is moved into the ticket's directory.
 * 4. The worktree and the local branch are removed.
 */
export async function cleanupWorktree(options: CleanupWorktreeOptions): Promise<CleanupWorktreeResult> {
  const { checkout, stateDir, ticketId, directory, branch, base, review, env, signal } = options
  const timeoutMs = options.timeoutMs ?? 60_000
  const root = resolve(join(stateDir, 'work'))
  const dir = resolve(directory)
  // A guard, not a convenience: removing the operator's checkout or the state directory itself is never cleanup.
  if (dir === resolve(checkout) || dir === root || !dir.startsWith(`${root}${sep}`)) {
    return { removed: false, pushed: false, skipped: 'outsideState' }
  }

  if (await exists(dir)) {
    await savePatch(dir, stateDir, ticketId)
    await moveLegacyLog(dir, join(stateDir, 'tickets', ticketId))
  }

  let pushed = false
  if (!review && branch) pushed = await pushBranch({ checkout, branch, base, env, signal, timeoutMs })

  await removeWorktree(checkout, dir, signal, branch)
  // A checkout without git, or a worktree git refused, leaves a plain directory; it is still inside stateDir/work.
  if (await exists(dir)) await rm(dir, { recursive: true, force: true })
  return { removed: true, pushed }
}

/** Saves what the agent left uncommitted, including untracked files, so removing the worktree loses no edit. */
async function savePatch(directory: string, stateDir: string, ticketId: string): Promise<void> {
  let status: string
  try { status = await run('git', ['-C', directory, 'status', '--porcelain'], { timeoutMs: 30_000 }) } catch { return }
  const dirty = status.split('\n').some(line => {
    const path = line.slice(3).trim()
    return path.length > 0 && path !== '.superagent' && !path.startsWith('.superagent/')
  })
  if (!dirty) return
  // A dirty worktree is work: if its patch cannot be written, the caller keeps the worktree rather than deleting the only copy.
  await run('git', ['-C', directory, 'add', '-A'], { timeoutMs: 60_000 })
  const patch = await run('git', ['-C', directory, 'diff', '--cached', '--binary', '--', '.', ':(exclude).superagent'], { timeoutMs: 60_000 })
  await run('git', ['-C', directory, 'reset', '-q'], { timeoutMs: 30_000 }).catch(() => '')
  if (!patch.trim()) return
  const path = join(stateDir, 'tickets', ticketId, 'worktree.patch')
  await mkdir(join(stateDir, 'tickets', ticketId), { recursive: true })
  await writeFile(path, patch, 'utf8')
}

/**
 * Pushes a ticket's branch when the remote does not already have its commits.
 * @returns whether a push happened.
 * @throws when the push fails, so the caller keeps the worktree instead of deleting the only copy.
 */
async function pushBranch(input: {
  checkout: string
  branch: string
  base?: string | undefined
  env?: Record<string, string> | undefined
  signal?: AbortSignal | undefined
  timeoutMs: number
}): Promise<boolean> {
  const { checkout, branch, base, env, signal, timeoutMs } = input
  // A local-only checkout has nowhere to push; its removal loses no remote work.
  try { await run('git', ['-C', checkout, 'remote', 'get-url', 'origin'], { signal, timeoutMs: 10_000 }) } catch { return false }
  try { await run('git', ['-C', checkout, 'rev-parse', '--verify', `refs/heads/${branch}`], { signal, timeoutMs: 10_000 }) } catch { return false }
  // A branch whose commits are all on some remote needs no push, even when that remote branch is the request merged and
  // deleted; the base then says whether this ticket added anything, so a branch left at the checkout's own commit is not
  // published. Without a base, an older worktree, anything no remote has is worth pushing.
  const unreachable = Number((await run('git', ['-C', checkout, 'rev-list', '--count', branch, '--not', '--remotes'], { signal, timeoutMs: 30_000 })).trim())
  if (!Number.isFinite(unreachable) || unreachable === 0) return false
  const added = base
    ? Number((await run('git', ['-C', checkout, 'rev-list', '--count', `${base}..${branch}`], { signal, timeoutMs: 30_000 })).trim())
    : unreachable
  if (!Number.isFinite(added) || added === 0) return false

  // The agent usually pushed its branch before it opened the request; a remote that already contains it needs no push.
  let remote: string
  // The worker's environment carries the agent's credentials: a private remote answers `ls-remote` only with them.
  try { remote = (await run('git', ['-C', checkout, 'ls-remote', '--heads', 'origin', branch], { env, signal, timeoutMs: 30_000 })).trim() } catch { remote = '' }
  if (remote) {
    try {
      await run('git', ['-C', checkout, 'fetch', '--quiet', 'origin', branch], { env, signal, timeoutMs })
      await run('git', ['-C', checkout, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, 'FETCH_HEAD'], { signal, timeoutMs: 30_000 })
      return false
    } catch { /* the remote diverged; the push below reports whether it can be updated */ }
  }
  await run('git', ['-C', checkout, 'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { env, signal, timeoutMs })
  return true
}

/** Moves a run log written inside the worktree by an older version into the ticket's directory. */
async function moveLegacyLog(directory: string, ticketDir: string): Promise<void> {
  const source = join(directory, '.superagent', 'log.md')
  if (!await exists(source)) return
  await mkdir(ticketDir, { recursive: true })
  for (const target of [join(ticketDir, 'log.md'), join(ticketDir, 'log.worktree.md')]) {
    if (await exists(target)) continue
    try { await rename(source, target) } catch { await copyFile(source, target); await rm(source, { force: true }) }
    return
  }
  // Both names are taken: keep the legacy run under a name of its own rather than delete it with the worktree.
  const dated = join(ticketDir, `log-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
  try { await rename(source, dated) } catch { await copyFile(source, dated); await rm(source, { force: true }) }
}
