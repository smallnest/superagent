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
import { WorkflowStore, MemoryStore, memoryCommand, nextIssue, workflowCommand } from '../src/workflow.ts'

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
  *"issues/2551") cat ${JSON.stringify(join(bin, 'issue-2551.json'))} ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 })
  await writeFile(lark, `#!/bin/sh
echo "lark $*" >> ${JSON.stringify(calls)}
case "$*" in
  "config show"*) echo '{"appId":"cli_test"}' ;;
  "im +chat-messages-list"*)
    if [ -f ${JSON.stringify(event)} ]; then cat ${JSON.stringify(event)}; else echo '{"messages":[]}'; fi
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
  await writeFile(join(bin, 'issue-2551.json'), JSON.stringify(issues.find(issue => (issue as { iid?: number }).iid === 2551) ?? issues[0] ?? {}))
  for (const file of [glab, lark, join(bin, 'fake-agent')]) await chmod(file, 0o755)
  return { glab, lark, event }
}

/** A Feishu direct chat's recent messages, as the bot reads them. */
function message(text: string): string {
  return JSON.stringify({
    messages: [{
      message_id: `om_${text.length}_${Date.now()}`,
      content: text,
      create_time: '2026-01-01 00:00',
      sender: { id: 'ou_alice' },
    }],
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

  it('moves on when GitLab has closed the issue outside the workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-workflow-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    const first = { ...issue, iid: 2551, title: 'A gRPC edge', web_url: 'https://gitlab.example.com/acme/widgets/-/issues/2551' }
    const second = { ...issue, iid: 2552, title: 'Another gRPC edge', web_url: 'https://gitlab.example.com/acme/widgets/-/issues/2552' }
    const { glab, lark } = await fakes(bin, [first, second])
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
    const store = new WorkflowStore(settings.stateDir)
    const run = async (): Promise<void> => {
      await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true, finish: true })
    }

    await run()
    expect((await store.get(2551))?.phase).toBe('waiting')

    // A person closes #2551 on GitLab; the local record must follow rather than block the queue.
    await writeFile(join(bin, 'issue-2551.json'), JSON.stringify({ ...first, state: 'closed' }))
    await run()
    expect((await store.get(2551))?.phase).toBe('done')
    expect((await store.get(2552))?.phase).toBe('waiting')
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
  it('proposes the oldest issue first: dependencies are lower-numbered', () => {
    const issues = [
      { iid: 2551, title: 'A gRPC edge' },
      { iid: 2585, title: '[Phase 0] Cleanup' },
      { iid: 2560, title: 'Another gRPC edge' },
    ]
    expect(nextIssue(issues, new Set())?.iid).toBe(2551)
    expect(nextIssue(issues, new Set([2551]))?.iid).toBe(2560)
    expect(nextIssue(issues, new Set([2551, 2560]))?.iid).toBe(2585)
    expect(nextIssue(issues, new Set([2551, 2560, 2585]))).toBeUndefined()
  })

  it('reads the four answers and nothing else', () => {
    expect(workflowCommand('做 #2585')).toEqual({ verb: 'do', iid: 2585 })
    expect(workflowCommand('不做#2585')).toEqual({ verb: 'skip', iid: 2585 })
    expect(workflowCommand(' 关闭 2585 ')).toEqual({ verb: 'close', iid: 2585 })
    expect(workflowCommand('保留 #42')).toEqual({ verb: 'keep', iid: 42 })
    expect(workflowCommand('做 #2585 顺便看下日志')).toBeUndefined()
    expect(workflowCommand('好的')).toBeUndefined()
  })

  it('reads a rule and keeps the memory short, newest last, with no duplicate line', async () => {
    expect(memoryCommand('记住 #2551 gRPC 大包必须调 HTTP/2 窗口')).toEqual({ iid: 2551, text: 'gRPC 大包必须调 HTTP/2 窗口' })
    expect(memoryCommand('记一下 #2551')).toBeUndefined()
    expect(memoryCommand('做 #2551')).toBeUndefined()

    const root = await mkdtemp(join(tmpdir(), 'superagent-memory-'))
    dirs.push(root)
    const memory = new MemoryStore(root)
    await memory.remember('rule one', 2, new Date('2026-01-01T00:00:00Z'))
    await memory.remember('rule two', 2, new Date('2026-01-02T00:00:00Z'))
    await memory.remember('rule two', 2, new Date('2026-01-02T00:00:00Z'))
    expect(await memory.rules()).toEqual(['- 2026-01-01 rule one', '- 2026-01-02 rule two'])
    await memory.remember('rule three', 2, new Date('2026-01-03T00:00:00Z'))
    expect(await memory.rules()).toEqual(['- 2026-01-02 rule two', '- 2026-01-03 rule three'])
    expect(await memory.dueForReview(7)).toBe(true)
    await memory.markReviewed(new Date())
    expect(await memory.dueForReview(7)).toBe(false)
  })
})
