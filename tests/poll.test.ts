/**
 * Proves one poll round end to end with a stand-in `gh` and a stand-in agent, so the test needs no network and no model:
 * a mention becomes a Trigger, the Trigger becomes a ticket, the ticket runs, and its report comes back.
 */
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FileRepositories } from '../src/state/files.ts'
import { SettingsSchema } from '../src/settings.ts'
import { runLoop } from '../src/runner.ts'
import { ticketBranch } from '../src/infra/worktree.ts'

const dirs: string[] = []
afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

/** A `gh` that answers the three calls a round makes, and a `fake-agent` that writes the report it is asked for. */
async function fakes(bin: string): Promise<void> {
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "api user") echo '{"login":"smallnest-agent"}' ;;
  "api notifications"*)
    echo '[{"id":"n1","reason":"mention","updated_at":"2026-01-01T00:00:00Z","subject":{"title":"Fix the typo","type":"Issue","url":"https://api.github.com/repos/acme/widgets/issues/7","latest_comment_url":"https://api.github.com/repos/acme/widgets/issues/comments/42"},"repository":{"full_name":"acme/widgets"}}]'
    ;;
  "api repos/acme/widgets/issues/comments/42")
    echo '{"id":42,"body":"@smallnest-agent please fix the typo in the README","user":{"login":"alice","type":"User"},"html_url":"https://github.com/acme/widgets/issues/7#issuecomment-42","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}'
    ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 })
  await writeFile(join(bin, 'fake-agent'), `#!/bin/sh
cat > /dev/null
mkdir -p .superagent
printf '{"summary":"Fixed the typo.","state":"ready","prs":[]}' > .superagent/report.json
`, { mode: 0o755 })
  await chmod(join(bin, 'gh'), 0o755)
  await chmod(join(bin, 'fake-agent'), 0o755)
}

/** The tool runs a fake agent under a runner name only its path selects. */
const agentBinary = (bin: string): string => join(bin, 'fake-agent')

describe('a poll round', () => {
  it('turns a mention into a ticket and records its report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-poll-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    await fakes(bin)

    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'),
      checkout: root,
      github: { enabled: true, repository: 'acme/widgets', cli: join(bin, 'gh'), allowed: ['alice'], pollSeconds: 60 },
      executor: { agent: 'codex', binary: agentBinary(bin), maxWorkers: 1, timeoutMinutes: 5, prepare: '', blockedCommands: [] },
      // A mention is an explicit request, so it needs no assessment; a stand-in that fails would only make the round wait.
      assess: { binary: join(bin, 'no-assessor') },
      prompts: '',
    })
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()

    await initRepository(root)

    // The fake agent is a Codex stand-in: the Codex runner reads its last message file and the report file.
    await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true })
    await new Promise(resolve => setTimeout(resolve, 400))

    const tickets = repo.tickets.list()
    expect(tickets).toHaveLength(1)
    expect(tickets[0]!.title).toContain('fix the typo')
    expect(tickets[0]!.mandate.actor.id).toBe('alice')

    const triggers = [...repo.keys()].filter(name => name.startsWith('trigger:'))
    expect(triggers.length).toBeGreaterThan(0)

    // The ticket ran in its own worktree, on a branch of its own, so it cannot disturb the operator's checkout.
    const branch = ticketBranch(settings.branchPrefix, tickets[0]!.title, tickets[0]!.id)
    const current = execFileSync('git', ['-C', join(settings.stateDir, 'work', tickets[0]!.id), 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim()
    expect(current).toBe(branch)
    const parent = execFileSync('git', ['-C', join(settings.stateDir, 'work', tickets[0]!.id), 'rev-parse', 'HEAD']).toString().trim()
    expect(parent).toBe(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim())

    // A second round records the report the agent wrote and ends the ticket with it.
    await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true })
    await new Promise(resolve => setTimeout(resolve, 300))
    const ended = repo.tickets.list()[0]!
    const log = await readFile(join(settings.stateDir, 'work', ended.id, '.superagent', 'log.md'), 'utf8').catch(() => '')
    expect(log, 'the agent run is recorded beside its worktree').toContain('Fixed the typo.')
  }, 30_000)

  it('ignores a mention from a login that is not allowed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-poll-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    await fakes(bin)
    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'), checkout: root,
      github: { enabled: true, repository: 'acme/widgets', cli: join(bin, 'gh'), allowed: ['bob'], pollSeconds: 60 },
      executor: { agent: 'codex', binary: agentBinary(bin) },
      assess: { binary: join(bin, 'no-assessor') },
    })
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()
    await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(repo.tickets.list()).toHaveLength(0)
  }, 30_000)

  it('does not receive the same notification twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-poll-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    await fakes(bin)
    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'), checkout: root,
      github: { enabled: true, repository: 'acme/widgets', cli: join(bin, 'gh'), allowed: ['alice'], pollSeconds: 60 },
      executor: { agent: 'codex', binary: agentBinary(bin) },
      assess: { binary: join(bin, 'no-assessor') },
    })
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()
    const signal = new AbortController().signal
    await runLoop({ settings, repo, signal, log: () => {}, once: true })
    await runLoop({ settings, repo, signal, log: () => {}, once: true })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(repo.tickets.list()).toHaveLength(1)
  }, 30_000)
})

/** A checkout with one commit, which a ticket branches from. */
function initRepository(directory: string): void {
  const git = (...args: string[]): void => { execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' }) }
  git('init', '-q')
  git('-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '--allow-empty', '-m', 'initial')
}

/** Reads a file the loop wrote, failing the test with the path when it is missing. */
export async function readOr(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
