/**
 * Proves one poll round end to end with a stand-in `gh` and a stand-in agent, so the test needs no network and no model:
 * a mention becomes a Trigger, the Trigger becomes a ticket, the ticket runs, and its report comes back.
 */
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FileRepositories } from '../src/state/files.ts'
import { SettingsSchema } from '../src/settings.ts'
import { runLoop } from '../src/runner.ts'
import { ticketBranch } from '../src/infra/worktree.ts'

const dirs: string[] = []
afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

/** Two mentions, one per comment, so a round has two tickets to run at once. */
const MENTIONS = [
  { id: 'n1', number: 7, title: 'Fix the typo', comment: 42, body: '@smallnest-agent please fix the typo in the README' },
  { id: 'n2', number: 8, title: 'Fix the link', comment: 43, body: '@smallnest-agent please fix the broken link' },
]

/** A `gh` that answers the calls a round makes for `mentions`, and a `fake-agent` that writes the report it is asked for. */
async function fakes(bin: string, mentions = MENTIONS.slice(0, 1)): Promise<void> {
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "api user") echo '{"login":"smallnest-agent"}' ;;
  "api notifications"*)
    echo '${JSON.stringify(mentions.map((mention, index) => ({ id: mention.id, reason: 'mention', updated_at: `2026-01-01T00:00:0${index}Z`,
      subject: { title: mention.title, type: 'Issue', url: `https://api.github.com/repos/acme/widgets/issues/${mention.number}`,
        latest_comment_url: `https://api.github.com/repos/acme/widgets/issues/comments/${mention.comment}` }, repository: { full_name: 'acme/widgets' } })))}'
    ;;
${mentions.map(mention => `  "api repos/acme/widgets/issues/comments/${mention.comment}")
    echo '${JSON.stringify({ id: mention.comment, body: mention.body, user: { login: 'alice', type: 'User' }, html_url: `https://github.com/acme/widgets/issues/${mention.number}#issuecomment-${mention.comment}`, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })}'
    ;;`).join('\n')}
  *) echo '{}' ;;
esac
`, { mode: 0o755 })
  // Each turn leaves a mark in the binary's directory, so a test can tell whether it began; it ends when `gate-file` is deleted.
  await writeFile(join(bin, 'fake-agent'), `#!/bin/sh
cat > /dev/null
mkdir -p .superagent
touch ${JSON.stringify(bin)}/turns.$$_$(date +%s)
if [ -n "$GATE" ]; then while [ -e "$GATE" ]; do sleep 0.05; done; fi
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

describe('a poll round with a worker limit', () => {
  it('starts one turn at a time when maxWorkers is 1, and the next when the first ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-poll-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    await fakes(bin, MENTIONS)
    const gate = join(root, 'gate')
    await writeFile(gate, '')
    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'), checkout: root,
      github: { enabled: true, repository: 'acme/widgets', cli: join(bin, 'gh'), allowed: ['alice'], pollSeconds: 60 },
      executor: { agent: 'codex', binary: agentBinary(bin), maxWorkers: 1 },
      assess: { binary: join(bin, 'no-assessor') },
    })
    // The agent's environment carries the gate, as the installation's own variables would.
    process.env.GATE = gate
    await chmod(bin, 0o755)
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()
    await initRepository(root)
    try {
      await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true })
      // A turn that ended may have its report yet to reach the Engine, so a turn counts until the tickets end.
      const started = async (): Promise<number> => (await readdir(bin)).filter(name => name.startsWith('turns.')).length
      await until(async () => await started() >= 1)
      expect(await started()).toBe(1)
      expect(repo.tickets.list()).toHaveLength(2)
      // The first turn waits on the gate, so the second ticket is accepted but no turn of it begins. One turn may end and
      // hand the slot to the second, so this repeats: at no moment may two agents wait on the gate at once.
      for (let check = 0; check < 5; check++) {
        await new Promise(resolve => setTimeout(resolve, 120))
        const running = repo.tickets.list().filter(ticket => ticket.ended === undefined && ticket.assignments.at(-1)?.state === 'running').length
        expect(running).toBeLessThanOrEqual(1)
      }
      await rm(gate)
      await until(async () => await started() === 2, 20_000)
    } finally { delete process.env.GATE }
  }, 40_000)

  it('restarts an assignment a previous process left running, with a recovery note', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-poll-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    await fakes(bin)
    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'), checkout: root,
      github: { enabled: true, repository: 'acme/widgets', cli: join(bin, 'gh'), allowed: [], pollSeconds: 60 },
      executor: { agent: 'codex', binary: agentBinary(bin) },
      assess: { binary: join(bin, 'no-assessor') },
    })
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()
    await initRepository(root)
    // A ticket a stopped process left running: its assignment claims to run, but no agent does.
    const at = new Date(Date.now() - 60_000).toISOString()
    repo.tickets.save({
      id: 'left-running', title: 'Fix the typo', decisionId: 'decision-1', createdAt: at, updatedAt: at,
      mandate: { strength: 'explicit', actor: { source: 'github', id: 'alice' }, basis: { via: 'listed', addressed: 'mention' }, policyVersion: 'observe:', scope: '' },
      channels: [], assignments: [{ id: 'assignment-1', state: 'running', createdAt: at, startedAt: at }],
      inputs: [{ id: 'input-1', kind: 'text', text: 'Please fix the typo.', at }], undelivered: [], origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
    } as never)
    await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true })
    await until(async () => repo.tickets.list()[0]!.assignments.at(-1)?.report?.state === 'ready', 20_000)
    const ticket = repo.tickets.list()[0]!
    // The assignment that claimed to run ended as one the host interrupted, and a new one did the work.
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.assignments[0]).toMatchObject({ id: 'assignment-1', state: 'ended', endedReason: 'hostRestarted' })
    // The new assignment starts in a mark of its own, so it may have ended by the time the loop is done; its start is what
    // proves the recovery, and so is the report that ended the turn.
    expect(ticket.assignments[1]).toMatchObject({ startedAt: expect.any(String), report: { state: 'ready' } })
    expect(ticket.inputs.some(input => input.kind === 'text' && input.text.includes('The host restarted'))).toBe(true)
    // A fresh turn reads no session, so the recovery note goes into the prompt it works from.
    const log = await readFile(join(settings.stateDir, 'work', ticket.id, '.superagent', 'log.md'), 'utf8')
    expect(log).toContain('## Notes since the start')
    expect(log).toContain('The host restarted during this ticket.')
    expect(ticket.inputs.map(input => input.kind)).toEqual(['text', 'text'])
  }, 40_000)
})

/** Waits for `check` to hold, failing the test after `ms`. */
async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`The condition did not hold within ${ms} ms`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

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
