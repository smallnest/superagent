/**
 * Proves the issue workflow end to end with stand-ins: the bot proposes one labeled issue, asks in a Feishu direct
 * message, waits for `做`, runs the turn, sends the summary and asks to close, and closes only after `关闭`.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SettingsSchema } from '../src/settings.ts'
import { FileRepositories } from '../src/state/files.ts'
import { runLoop } from '../src/runner.ts'
import { WorkflowStore, nextIssue, workflowCommand } from '../src/workflow.ts'

const dirs: string[] = []
afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

const issue = {
  iid: 2585,
  title: '[Phase 0] Dead addresses',
  description: 'Clean up the dead addresses and duplicate registrations.',
  state: 'opened',
  web_url: 'https://gitlab.example.com/acme/widgets/-/issues/2585',
  updated_at: '2026-01-01T00:00:00Z',
  author: { username: 'alice', name: 'Alice', bot: false },
  labels: ['superagent'],
}

/** A `glab` that serves the queue and records every call, and a `lark-cli` that prints one event when a file holds it. */
async function fakes(bin: string, issues: unknown[] = [issue]): Promise<{ glab: string; lark: string; event: string }> {
  await mkdir(bin, { recursive: true })
  const calls = join(bin, 'calls.log')
  const event = join(bin, 'event.json')
  const glab = join(bin, 'glab')
  const lark = join(bin, 'lark-cli')
  await writeFile(glab, `#!/bin/sh
echo "glab $*" >> ${JSON.stringify(calls)}
case "$*" in
  *" user"*) echo '{"username":"gitlab-bot"}' ;;
  *"issues?state=opened&labels=superagent&per_page=100"*) cat <<'JSON'
${JSON.stringify(issues)}
JSON
    ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 })
  await writeFile(lark, `#!/bin/sh
echo "lark $*" >> ${JSON.stringify(calls)}
case "$*" in
  "config show"*) echo '{"appId":"cli_test"}' ;;
  "event consume"*)
    if [ -f ${JSON.stringify(event)} ]; then cat ${JSON.stringify(event)}; fi
    sleep 300
    ;;
  "im +messages-send"*) echo '{"chat_id":"oc_dm","message_id":"om_asked"}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 })
  await writeFile(join(bin, 'fake-agent'), `#!/bin/sh
cat > /dev/null
mkdir -p .superagent
printf '{"summary":"Removed the dead addresses.","state":"ready","prs":[]}' > .superagent/report.json
`, { mode: 0o755 })
  for (const file of [glab, lark, join(bin, 'fake-agent')]) await chmod(file, 0o755)
  return { glab, lark, event }
}

/** A Feishu direct message from alice, as the event stream prints one. */
function message(text: string): string {
  return JSON.stringify({
    message_id: `om_${text.length}_${Date.now()}`,
    chat_id: 'oc_dm',
    chat_type: 'p2p',
    sender_id: 'ou_alice',
    sender_type: 'user',
    content: text,
    create_time: '1767200000000',
    mentions: [],
  })
}

async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`The condition did not hold within ${ms} ms`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('the issue workflow', () => {
  it('asks before the work, summarizes after it, and closes only when told to', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-workflow-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    const { glab, lark, event } = await fakes(bin)
    await mkdir(join(root, 'work'), { recursive: true })
    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'), checkout: join(root, 'work'),
      gitlab: { enabled: true, host: 'gitlab.example.com', project: 'acme/widgets', cli: glab, allowed: ['alice'] },
      feishu: { enabled: true, cli: lark, chats: [], directMessages: true, allowed: ['ou_alice'] },
      workflow: { enabled: true, label: 'superagent', user: 'ou_alice', verifyCommands: [] },
      executor: { agent: 'codex', binary: join(bin, 'fake-agent'), maxWorkers: 1 },
      assess: { binary: join(bin, 'no-assessor') },
    })
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()
    const calls = async (): Promise<string> => readFile(join(bin, 'calls.log'), 'utf8').catch(() => '')
    const store = new WorkflowStore(settings.stateDir)
    const run = async (): Promise<void> => {
      await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true, finish: true })
    }

    // 1. The queue proposes the issue and the bot asks, but no turn starts.
    await run()
    await until(async () => (await calls()).includes('做 #2585'))
    expect(repo.tickets.list()).toHaveLength(1)
    expect(repo.tickets.list()[0]!.ended).toBeUndefined()
    expect((await store.get(2585))?.phase).toBe('waiting')
    expect(await calls()).toContain('lark im +messages-send --as bot --user-id ou_alice')
    expect(await calls()).toContain('#2585 [Phase 0] Dead addresses')

    // 2. `做 #2585` releases the held turn; its report is summarized and the bot asks to close.
    await writeFile(event, `${message('做 #2585')}\n`)
    await run()
    await until(async () => (await calls()).includes('完成 #2585'))
    expect(repo.tickets.list()[0]!.ended?.outcome).toBe('completed')
    expect((await store.get(2585))?.phase).toBe('closing')
    expect(await calls()).toContain('Removed the dead addresses.')
    expect(await calls()).toContain('关闭 #2585')

    // 3. `关闭 #2585` closes the issue; nothing is closed before that.
    expect(await calls()).not.toContain('state_event=close')
    await writeFile(event, `${message('关闭 #2585')}\n`)
    await run()
    await until(async () => (await calls()).includes('state_event=close'))
    expect((await store.get(2585))?.phase).toBe('done')
    expect(await calls()).toContain('glab api --hostname gitlab.example.com projects/acme%2Fwidgets/issues/2585 --method PUT --field state_event=close')
  }, 90_000)

  it('skips the issue when the operator says no', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-workflow-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    const { glab, lark, event } = await fakes(bin)
    await mkdir(join(root, 'work'), { recursive: true })
    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'), checkout: join(root, 'work'),
      gitlab: { enabled: true, host: 'gitlab.example.com', project: 'acme/widgets', cli: glab, allowed: ['alice'] },
      feishu: { enabled: true, cli: lark, chats: [], directMessages: true, allowed: ['ou_alice'] },
      workflow: { enabled: true, label: 'superagent', user: 'ou_alice' },
      executor: { agent: 'codex', binary: join(bin, 'fake-agent') },
      assess: { binary: join(bin, 'no-assessor') },
    })
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()
    const calls = async (): Promise<string> => readFile(join(bin, 'calls.log'), 'utf8').catch(() => '')
    const store = new WorkflowStore(settings.stateDir)

    await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true, finish: true })
    await writeFile(event, `${message('不做 #2585')}\n`)
    await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true, finish: true })
    await until(async () => (await store.get(2585))?.phase === 'skipped')
    expect(await calls()).toContain('已跳过 #2585')
    expect(repo.tickets.list()[0]!.ended).toBeDefined()
  }, 60_000)
})

describe('the workflow state', () => {
  it('proposes the Phase 0 issue first, then the lowest iid', () => {
    const issues = [
      { iid: 2551, title: 'A gRPC edge' },
      { iid: 2585, title: '[Phase 0] Cleanup' },
      { iid: 2560, title: 'Another gRPC edge' },
    ]
    expect(nextIssue(issues, new Set())?.iid).toBe(2585)
    expect(nextIssue(issues, new Set([2585]))?.iid).toBe(2551)
    expect(nextIssue(issues, new Set([2585, 2551, 2560]))).toBeUndefined()
  })

  it('reads the four answers and nothing else', () => {
    expect(workflowCommand('做 #2585')).toEqual({ verb: 'do', iid: 2585 })
    expect(workflowCommand('不做#2585')).toEqual({ verb: 'skip', iid: 2585 })
    expect(workflowCommand(' 关闭 2585 ')).toEqual({ verb: 'close', iid: 2585 })
    expect(workflowCommand('保留 #42')).toEqual({ verb: 'keep', iid: 42 })
    expect(workflowCommand('做 #2585 顺便看下日志')).toBeUndefined()
    expect(workflowCommand('好的')).toBeUndefined()
  })
})
