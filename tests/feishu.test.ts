/**
 * Proves the Feishu Source without a network: one message shape becomes a Trigger or does not, and one round of the loop
 * takes a message from the event stream to a reply in the same chat.
 */
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runLoop } from '../src/runner.ts'
import { readSettings } from '../src/settings.ts'
import { FileRepositories } from '../src/state/files.ts'
import { feishuTrigger } from '../src/sources/feishu.ts'
import { ticketBranch } from '../src/infra/worktree.ts'

const dirs: string[] = []
afterAll(async () => { if (!process.env.KEEP) await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

const CHAT = 'oc_team'

/** One message as the event stream prints it. */
const message = (overrides: Record<string, unknown> = {}): unknown => ({
  message_id: 'om_1', chat_id: CHAT, chat_type: 'group', sender_id: 'ou_alice', sender_type: 'user',
  content: '@_user_1 please fix the broken link', create_time: String(Date.parse('2026-01-01T00:00:00Z')),
  mentions: [{ id: 'ou_bot', key: '@_user_1', name: 'Agent' }], ...overrides,
})

const options = { botId: 'ou_bot', botAppId: 'cli_test', chats: new Map([[CHAT, false]]), directMessages: true }

describe('a Feishu message', () => {
  it('becomes a Trigger when it mentions the bot in a listened chat', () => {
    const trigger = feishuTrigger(message(), options)!
    expect(trigger.source).toBe('feishu')
    expect(trigger.actor.id).toBe('ou_alice')
    expect(trigger.addressed).toBe('mention')
    expect(trigger.text).toBe('@Agent please fix the broken link')
    expect(trigger.channel?.address.messageId).toBe('om_1')
  })

  it('is ignored when it does not mention the bot, when the bot wrote it, or when its chat is not listened to', () => {
    expect(feishuTrigger(message({ mentions: [] }), options)).toBeUndefined()
    expect(feishuTrigger(message({ sender_id: 'ou_bot' }), options)).toBeUndefined()
    expect(feishuTrigger(message({ chat_id: 'oc_other' }), options)).toBeUndefined()
  })

  it('is a direct message when it is sent to the bot alone', () => {
    const trigger = feishuTrigger(message({ chat_type: 'p2p', mentions: [] }), options)!
    expect(trigger.addressed).toBe('direct')
  })
})

/**
 * `lark-cli` that prints one event and then leaves, and an agent that reports back through the Feishu CLI. The bot lists
 * no chats, so the loop takes the chat from settings and the message arrives through the stream. The consumer leaves on
 * its own rather than waiting to be stopped, which is how a Feishu consumer ends when the connection closes.
 *
 * The agent runs as its own process, as it does in an installation, so the test also proves the report and the reply cross
 * that boundary. It writes the report with `node` and reads the request from the log, because the prompt arrives on stdin.
 */
async function fakes(bin: string, stateDir: string): Promise<void> {
  await mkdir(bin, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(bin, 'lark-cli'), `#!/bin/sh
case "$1 $2" in
  "config show") echo '{"appId":"cli_test"}' ;;
  "im +chat-list") echo '{"chats":[]}' ;;
  "im +messages-reply")
    while [ $# -gt 0 ]; do [ "$1" = "--idempotency-key" ] && echo "$2" >> ${JSON.stringify(join(stateDir, 'replies.txt'))}; shift; done
    ;;
  "event consume")
    printf '%s\\n' '{"message_id":"om_1","chat_id":"${CHAT}","chat_type":"group","sender_id":"ou_alice","sender_type":"user","content":"@_user_1 fix the heading","create_time":"1767225600000","mentions":[{"id":"ou_bot","key":"@_user_1","name":"Agent"}]}'
    ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 })
  await writeFile(join(bin, 'fake-agent'), `#!/bin/sh
cat > /dev/null
mkdir -p .superagent
printf '{"summary":"Fixed the heading.","state":"ready","prs":[]}' > .superagent/report.json
`, { mode: 0o755 })
  await chmod(join(bin, 'lark-cli'), 0o755)
  await chmod(join(bin, 'fake-agent'), 0o755)
}

/**
 * One installation whose rounds run in this process: the loop reads its state through the same files, and a ticket a stub
 * runs would wait on a child process of this one, which the test would have to drive by hand.
 */
const poll = async (dir: string, signal: AbortSignal): Promise<void> => {
  const settings = await readSettings(join(dir, 'settings.yaml'))
  const repo = new FileRepositories(settings.stateDir)
  await repo.open()
  await runLoop({ settings, repo, signal, once: true, log: () => {} })
}

describe('a Feishu round', () => {
  it('turns a message in the stream into a ticket and replies in the chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-feishu-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    const stateDir = join(root, 'state')
    await writeFile(join(root, 'settings.yaml'), `stateDir: ${stateDir}
checkout: ${root}
feishu:
  enabled: true
  cli: ${join(bin, 'lark-cli')}
  chats:
    - chatId: ${CHAT}
      name: Team
  allowed: [ou_alice]
executor:
  agent: codex
  binary: ${join(bin, 'fake-agent')}
  timeoutMinutes: 5
# The message addresses the bot, so no assessment runs; a stand-in that fails would only make the round wait.
assess:
  binary: ${join(bin, 'no-assessor')}
`)
    await fakes(bin, stateDir)
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '--allow-empty', '-m', 'initial'])

    // Feishu pushes the message, so it can arrive in any round: a round takes what the stream stored, then accepts it,
    // and a later one records the report the agent wrote and answers. The rounds end when the reply is out.
    const reply = async (): Promise<string> => readFile(join(stateDir, 'replies.txt'), 'utf8').catch(() => '')
    const controller = new AbortController()
    // A round does not wait for its agent, so rounds go until the whole chain is through: a round or two for the message,
    // a few more for the agent's process to start and report, and one to answer.
    for (let round = 0; round < 120 && !await reply(); round++) {
      await poll(root, controller.signal)
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    const tickets = new FileRepositories(stateDir)
    await tickets.open()
    const listed = tickets.tickets.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.mandate.actor.id).toBe('ou_alice')
    const work = join(stateDir, 'work', listed[0]!.id)
    expect(execFileSync('git', ['-C', work, 'branch', '--show-current'], { encoding: 'utf8' }).trim())
      .toBe(ticketBranch('agent/', listed[0]!.title, listed[0]!.id))
    expect(await reply()).not.toBe('')

  }, 60_000)
})
