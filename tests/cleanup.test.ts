/**
 * Proves a ticket's end does not lose the work that only its worktree holds: commits go to the remote before the branch
 * is deleted, uncommitted edits are saved as a patch, and the run log moves beside the ticket.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupWorktree, prepareWorktree } from '../src/infra/worktree.ts'

const dirs: string[] = []
afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/** A checkout with one commit and, unless asked otherwise, a bare repository as its origin. */
async function checkoutWithRemote(): Promise<{ root: string; checkout: string; origin: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'superagent-cleanup-'))
  dirs.push(root)
  const checkout = join(root, 'checkout')
  await mkdir(checkout, { recursive: true })
  git(checkout, 'init', '-q')
  await writeFile(join(checkout, 'README.md'), 'one\n')
  git(checkout, 'add', '.')
  git(checkout, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'base')
  const origin = join(root, 'origin.git')
  execFileSync('git', ['init', '--bare', '-q', origin])
  git(checkout, 'remote', 'add', 'origin', origin)
  return { root, checkout, origin, stateDir: join(root, 'state') }
}

/** Makes the worktree a run created, with the record cleanup reads. */
async function worktreeOf(input: { checkout: string; stateDir: string; ticketId: string; branch: string; review?: boolean }) {
  const directory = join(input.stateDir, 'work', input.ticketId)
  const prepared = await prepareWorktree({ checkout: input.checkout, directory, branch: input.branch })
  await mkdir(join(input.stateDir, 'tickets', input.ticketId), { recursive: true })
  await writeFile(join(input.stateDir, 'tickets', input.ticketId, 'worktree.json'),
    `${JSON.stringify({ branch: input.branch, ...prepared.base ? { base: prepared.base } : {}, review: input.review === true }, null, 2)}\n`)
  return { directory, base: prepared.base }
}

describe('a ticket worktree at the end', () => {
  it('pushes its commits, saves uncommitted work, moves the log, and removes the directory and branch', async () => {
    const { checkout, origin, stateDir } = await checkoutWithRemote()
    const branch = 'agent/ticket-one'
    const { directory, base } = await worktreeOf({ checkout, stateDir, ticketId: 'ticket-one', branch })

    // A commit the ticket made, an edit it did not, and the log an older version wrote inside the worktree.
    await writeFile(join(directory, 'feature.txt'), 'the ticket\'s work\n')
    git(directory, 'add', 'feature.txt')
    git(directory, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'feature')
    await writeFile(join(directory, 'README.md'), 'one\nchanged, not committed\n')
    await mkdir(join(directory, '.superagent'), { recursive: true })
    await writeFile(join(directory, '.superagent', 'log.md'), '## a run\n\nwhat the agent did\n')

    const result = await cleanupWorktree({ checkout, stateDir, ticketId: 'ticket-one', directory, branch, base, env: {} })

    expect(result).toEqual({ removed: true, pushed: true })
    // The commit is on the remote before the local branch goes.
    expect(git(origin, 'rev-parse', '--verify', `refs/heads/${branch}`)).toMatch(/^[0-9a-f]{40}$/)
    expect(await exists(directory)).toBe(false)
    expect(git(checkout, 'branch', '--list', branch)).toBe('')
    // The log is beside the ticket now, and the edit the agent never committed is a patch, not a deletion.
    expect(await readFile(join(stateDir, 'tickets', 'ticket-one', 'log.md'), 'utf8')).toContain('what the agent did')
    const patch = await readFile(join(stateDir, 'tickets', 'ticket-one', 'worktree.patch'), 'utf8')
    expect(patch).toContain('changed, not committed')
    expect(patch).not.toContain('.superagent')

    // A second cleanup has nothing left to do and does not fail.
    expect(await cleanupWorktree({ checkout, stateDir, ticketId: 'ticket-one', directory, branch, base, env: {} }))
      .toEqual({ removed: true, pushed: false })
  }, 30_000)

  it('does not push a branch the remote already has', async () => {
    const { checkout, origin, stateDir } = await checkoutWithRemote()
    const branch = 'agent/ticket-two'
    const { directory, base } = await worktreeOf({ checkout, stateDir, ticketId: 'ticket-two', branch })
    await writeFile(join(directory, 'feature.txt'), 'two\n')
    git(directory, 'add', 'feature.txt')
    git(directory, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'feature')
    git(directory, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
    const pushed = git(checkout, 'rev-parse', `refs/heads/${branch}`)

    const result = await cleanupWorktree({ checkout, stateDir, ticketId: 'ticket-two', directory, branch, base, env: {} })

    expect(result.pushed).toBe(false)
    expect(git(origin, 'rev-parse', `refs/heads/${branch}`)).toBe(pushed)
    expect(await exists(directory)).toBe(false)
    expect(git(checkout, 'branch', '--list', branch)).toBe('')
  }, 30_000)

  it('pushes an older worktree whose base was never recorded', async () => {
    const { checkout, origin, stateDir } = await checkoutWithRemote()
    const branch = 'agent/ticket-legacy'
    const { directory } = await worktreeOf({ checkout, stateDir, ticketId: 'ticket-legacy', branch })
    await writeFile(join(directory, 'feature.txt'), 'legacy\n')
    git(directory, 'add', 'feature.txt')
    git(directory, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'feature')

    const result = await cleanupWorktree({ checkout, stateDir, ticketId: 'ticket-legacy', directory, branch, env: {} })

    expect(result.pushed).toBe(true)
    expect(git(origin, 'rev-parse', `refs/heads/${branch}`)).toMatch(/^[0-9a-f]{40}$/)
  }, 30_000)

  it('does not publish a branch left at the checkout\'s own commit', async () => {
    const { checkout, origin, stateDir } = await checkoutWithRemote()
    const branch = 'agent/ticket-empty'
    const { directory, base } = await worktreeOf({ checkout, stateDir, ticketId: 'ticket-empty', branch })

    const result = await cleanupWorktree({ checkout, stateDir, ticketId: 'ticket-empty', directory, branch, base, env: {} })

    expect(result.pushed).toBe(false)
    expect(git(origin, 'branch', '--list', branch)).toBe('')
    expect(await exists(directory)).toBe(false)
  }, 30_000)

  it('never pushes a review checkout, whose branch belongs to the request', async () => {
    const { checkout, origin, stateDir } = await checkoutWithRemote()
    const branch = 'agent/review-three'
    const { directory, base } = await worktreeOf({ checkout, stateDir, ticketId: 'ticket-three', branch, review: true })
    await writeFile(join(directory, 'review.txt'), 'a comment I wrote about the change\n')
    git(directory, 'add', 'review.txt')
    git(directory, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'review notes')

    const result = await cleanupWorktree({ checkout, stateDir, ticketId: 'ticket-three', directory, branch, base, review: true, env: {} })

    expect(result.pushed).toBe(false)
    expect(git(origin, 'branch', '--list', branch)).toBe('')
    expect(git(checkout, 'branch', '--list', branch)).toBe('')
  }, 30_000)

  it('keeps the worktree and branch when the push fails', async () => {
    const { root, checkout, stateDir } = await checkoutWithRemote()
    git(checkout, 'remote', 'set-url', 'origin', join(root, 'missing.git'))
    const branch = 'agent/ticket-four'
    const { directory, base } = await worktreeOf({ checkout, stateDir, ticketId: 'ticket-four', branch })
    await writeFile(join(directory, 'feature.txt'), 'four\n')
    git(directory, 'add', 'feature.txt')
    git(directory, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '-m', 'feature')

    await expect(cleanupWorktree({ checkout, stateDir, ticketId: 'ticket-four', directory, branch, base, env: {} })).rejects.toThrow()

    // The only copy of the commit is still here, so the next round may push it.
    expect(await exists(directory)).toBe(true)
    expect(git(checkout, 'branch', '--list', branch)).not.toBe('')
  }, 30_000)

  it('removes a plain directory when the checkout is not a git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-cleanup-plain-'))
    dirs.push(root)
    const checkout = join(root, 'checkout')
    await mkdir(checkout, { recursive: true })
    const stateDir = join(root, 'state')
    const directory = join(stateDir, 'work', 'ticket-five')
    await mkdir(directory, { recursive: true })
    await mkdir(join(directory, '.superagent'), { recursive: true })
    await writeFile(join(directory, '.superagent', 'log.md'), 'a chat-only run\n')

    const result = await cleanupWorktree({ checkout, stateDir, ticketId: 'ticket-five', directory, branch: 'agent/five', env: {} })

    expect(result).toEqual({ removed: true, pushed: false })
    expect(await exists(directory)).toBe(false)
    expect(await readFile(join(stateDir, 'tickets', 'ticket-five', 'log.md'), 'utf8')).toContain('a chat-only run')
  }, 30_000)

  it('refuses to remove the operator checkout\'s own directory', async () => {
    const { checkout, stateDir } = await checkoutWithRemote()
    const result = await cleanupWorktree({ checkout, stateDir, ticketId: 'ticket-six', directory: checkout, branch: 'main', env: {} })
    expect(result).toEqual({ removed: false, pushed: false, skipped: 'outsideState' })
    expect(await exists(checkout)).toBe(true)
  }, 30_000)
})
