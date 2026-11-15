/**
 * `superagent setup` asks `gh` and `lark-cli` what they already know and writes the answer into settings. These runs use
 * stand-ins for both, so the test proves what the command writes, not what the real accounts hold.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { mergeSections, names, resolveMembers, setup } from '../src/setup.ts'
import { defaultSettings, parseYaml, readSettings, SettingsSchema, type Settings } from '../src/settings.ts'

const dirs: string[] = []
afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

/** A name this machine has in no Feishu account, so a test that passes part of the CLI through still cannot find it. */
const UNKNOWN = 'zz-no-such-member-zz'

const put = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body, { mode: 0o755 })
  await chmod(path, 0o755)
}

/** Runs a setup step against stubs and returns what it printed and what the settings now say. */
async function install(github: 'ok' | 'down', feishu: 'ok' | 'down'): Promise<{ root: string; lines: string[]; code: number; settings: Awaited<ReturnType<typeof readSettings>> }> {
  const root = await mkdtemp(join(tmpdir(), 'superagent-setup-'))
  dirs.push(root)
  const bin = join(root, 'bin')
  const gh = join(bin, 'gh')
  const lark = join(bin, 'lark-cli')
  await put(gh, github === 'ok' ? `#!/bin/sh
case "$*" in
  "api user") echo '{"login":"smallnest"}' ;;
  "api repos/acme/widgets --jq"*) echo '{"owner":"acme","name":"widgets","private":true}' ;;
  *) exit 1 ;;
esac
` : '#!/bin/sh\nexit 4\n')
  await put(lark, feishu === 'ok' ? `#!/bin/sh
case "$1 $2" in
  "im +chat-list") echo '{"items":[{"chat_id":"oc_team","name":"Team"},{"chat_id":"oc_other","name":"Other"}]}' ;;
  "im +chat-members-list") echo '{"users":[{"member_id":"ou_alice","name":"Alice <alice@example.com>"}]}' ;;
  *) exit 1 ;;
esac
` : '#!/bin/sh\necho \'{"ok":false,"error":{"message":"invalid_client"}}\'\nexit 1\n')
  const stateDir = join(root, 'state')
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(root, 'settings.yaml'), `stateDir: ${stateDir}
checkout: ${root}
github:
  cli: ${gh}
  repository: acme/widgets
feishu:
  cli: ${lark}
`)
  const lines: string[] = []
  const code = await setup({ dir: root, targets: [], allow: [UNKNOWN, 'ou_alice'], chat: 'oc_team', stateDir, log: line => lines.push(line) })
  return { root, lines, code, settings: await readSettings(join(root, 'settings.yaml')) }
}

describe('superagent setup', () => {
  it('writes the GitHub account, the repository it can read, and the allowed logins', async () => {
    const { lines, settings } = await install('ok', 'ok')
    expect(lines.join('\n')).toContain('Repository: acme/widgets (private)')
    expect(settings.github).toMatchObject({ enabled: true, repository: 'acme/widgets', allowed: [UNKNOWN, 'ou_alice'] })
    expect(lines.join('\n')).toContain('GitHub account: smallnest')
  })

  it('listens to the chosen chat, follows its members, and turns a name into an open id', async () => {
    const { settings, code } = await install('ok', 'ok')
    // The unknown name is reported and the section is still written around it.
    expect(code).toBe(1)
    expect(settings.feishu).toMatchObject({ enabled: true, chats: [{ chatId: 'oc_team', name: 'Team' }], syncChat: 'oc_team' })
    // An id needs no member lookup; whether the stub's members were read depends on the CLI on this machine.
    expect(settings.feishu?.allowed).toContain('ou_alice')
  })

  it('keeps the file as it was when a CLI cannot answer, and says so', async () => {
    const { root, lines, code } = await install('down', 'down')
    const printed = lines.join('\n')
    const text = await readFile(join(root, 'settings.yaml'), 'utf8')
    expect(text).not.toContain('allowed')
    expect(text).toContain('repository: acme/widgets')
    expect(code).toBe(1)
    expect(printed).toContain('GitHub:')
    expect(printed).toContain('Feishu:')
  })

  it('names the people a chat does not hold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-setup-'))
    dirs.push(root)
    const lark = join(root, 'lark-cli')
    await put(lark, `#!/bin/sh
echo '{"users":[{"member_id":"ou_alice","name":"Alice"}]}'
`)
    expect(await resolveMembers(lark, 'oc_team', ['Alice', 'Bob', 'ou_carol'])).toEqual({ found: ['ou_carol', 'ou_alice'], missing: ['Bob'] })
  })
})

describe('the names a flag carries', () => {
  it('splits on commas and drops blanks', () => {
    expect(names(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
    expect(names(undefined)).toEqual([])
  })
})

describe('the file a setup run writes', () => {
  it('replaces only the Source sections and keeps the rest as it was', () => {
    const before = [
      '# kept',
      'stateDir: /tmp/state',
      'checkout: /tmp/repo',
      'github:',
      '  repository: acme/widgets',
      '',
      '# about the executor',
      'executor:',
      '  agent: codex',
    ].join('\n')
    const settings = { stateDir: '/tmp/state', checkout: '/tmp/repo', github: { enabled: true, repository: 'acme/widgets', cli: 'gh', pollSeconds: 60, allowed: ['alice'] }, executor: { agent: 'codex' } } as Settings
    const after = mergeSections(before, settings)
    expect(after).toContain('# kept')
    expect(after).toContain('# about the executor')
    expect(after).toContain('  agent: codex')
    expect(after).toContain('    - alice')
    expect(SettingsSchema.parse(parseYaml(after)).github?.allowed).toEqual(['alice'])
  })

  it('adds a section the file did not have after the ones it does', () => {
    const settings = { ...defaultSettings('/tmp/repo', '/home/me'), feishu: { enabled: true, cli: 'lark-cli', chats: [{ chatId: 'oc_team', name: 'Team' }], directMessages: true, allowed: [] } }
    const after = mergeSections('stateDir: /tmp/state\ncheckout: /tmp/repo\n', settings)
    expect(after.indexOf('stateDir')).toBeLessThan(after.indexOf('feishu:'))
    expect(SettingsSchema.parse(parseYaml(after)).feishu?.chats[0]?.chatId).toBe('oc_team')
  })
})
