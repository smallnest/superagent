/**
 * Proves the GitLab Source end to end with a stand-in `glab`: a to-do becomes a ticket and its report comes back as a
 * note, and an open merge request is reviewed and merged with the parameters GitLab takes. No network and no model.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SettingsSchema, defaultSettings, parseYaml, readSettings, writeSettings } from '../src/settings.ts'
import { gitlabOrigin, setup } from '../src/setup.ts'
import { writeEnvironment } from '../src/infra/environment.ts'
import { FileRepositories } from '../src/state/files.ts'
import { runLoop } from '../src/runner.ts'

const dirs: string[] = []
afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

const todo = {
  id: 501,
  action_name: 'mentioned',
  target_type: 'Issue',
  author: { username: 'alice', name: 'Alice', bot: false },
  target: { iid: 7, title: 'Fix the typo', description: 'The README has a typo', state: 'opened',
    web_url: 'https://gitlab.example.com/acme/widgets/-/issues/7' },
  project: { path_with_namespace: 'acme/widgets' },
  body: '@gitlab-bot please fix the typo in the README',
  target_url: 'https://gitlab.example.com/acme/widgets/-/issues/7',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const mergeRequest = {
  iid: 9,
  title: 'Add a health check',
  description: 'Adds /healthz to the service.',
  author: { username: 'bob', name: 'Bob', bot: false },
  updated_at: '2026-01-01T00:00:00Z',
  web_url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/9',
  source_branch: 'feature/health',
  sha: 'abc123',
  draft: false,
}

/**
 * A `glab` that answers the calls a round makes and records every call it received, and a `fake-agent` that writes the
 * report it is asked for.
 */
async function fakes(bin: string, data: { todos?: unknown[]; mergeRequests?: unknown[]; report?: string } = {}): Promise<string> {
  await mkdir(bin, { recursive: true })
  const calls = join(bin, 'calls.log')
  const todos = JSON.stringify(data.todos ?? [])
  const mergeRequests = JSON.stringify(data.mergeRequests ?? [])
  await writeFile(join(bin, 'glab'), `#!/bin/sh
echo "$*" >> ${JSON.stringify(calls)}
case "$*" in
  *" user"*) echo '{"username":"gitlab-bot"}' ;;
  *"todos?state=pending&per_page=100"*) cat <<'JSON'
${todos}
JSON
    ;;
  *"merge_requests?state=opened&per_page=100"*) cat <<'JSON'
${mergeRequests}
JSON
    ;;
  *" projects/acme%2Fwidgets") echo '{"path_with_namespace":"acme/widgets","visibility":"private"}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 })
  await writeFile(join(bin, 'fake-agent'), `#!/bin/sh
cat > /dev/null
mkdir -p .superagent
printf '%s' '${data.report ?? '{"summary":"Fixed the typo.","state":"ready","prs":[]}'}' > .superagent/report.json
`, { mode: 0o755 })
  await chmod(join(bin, 'glab'), 0o755)
  await chmod(join(bin, 'fake-agent'), 0o755)
  return calls
}

function initRepository(directory: string): void {
  const git = (...args: string[]): void => { execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' }) }
  git('init', '-q')
  git('-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-q', '--allow-empty', '-m', 'initial')
}

/** Waits for `check` to hold, failing the test after `ms`. */
async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`The condition did not hold within ${ms} ms`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Runs one round, waiting for the turns it started and their cleanup: a later round must not treat them as interrupted. */
async function round(settings: ReturnType<typeof SettingsSchema.parse>, repo: FileRepositories): Promise<void> {
  await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true, finish: true })
}

describe('a GitLab to-do', () => {
  it('turns a mention into a ticket and answers it with a note', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-gitlab-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    const calls = await fakes(bin, { todos: [todo] })
    initRepository(root)
    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'), checkout: root,
      gitlab: { enabled: true, host: 'gitlab.example.com', project: 'acme/widgets', cli: join(bin, 'glab'), pollSeconds: 60, allowed: ['alice'] },
      executor: { agent: 'codex', binary: join(bin, 'fake-agent'), maxWorkers: 1, timeoutMinutes: 5 },
      assess: { binary: join(bin, 'no-assessor') },
      prompts: '',
    })
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()

    await round(settings, repo)
    await until(async () => repo.tickets.list().length === 1)
    const ticket = repo.tickets.list()[0]!
    expect(ticket.title.toLowerCase()).toContain('fix the typo')
    expect(ticket.mandate.actor.id).toBe('alice')

    // The turn runs beside the round; the reply is queued when it ends and posted by a later round.
    const callsSeen = async (): Promise<string> => readFile(calls, 'utf8').catch(() => '')
    const postedLine = 'projects/acme%2Fwidgets/issues/7/notes --method POST'
    const posted = async (): Promise<boolean> => {
      const text = await callsSeen()
      return text.includes(postedLine) && text.includes('body=Fixed the typo')
    }
    await until(async () => { await round(settings, repo); return await posted() }, 20_000)
    const recorded = await callsSeen()
    expect(recorded).toContain('api --hostname gitlab.example.com todos?state=pending&per_page=100')
    expect(recorded).toContain('projects/acme%2Fwidgets/issues/7/notes --method POST --raw-field body=')
    expect(recorded).toContain('body=Fixed the typo')

    // The to-do stays pending on GitLab, so a round sees it again; the recorded id is what keeps it from a second ticket,
    // and the outbox's posted id keeps the answer from going out again in a later round or process.
    await round(settings, repo)
    await round(settings, repo)
    expect(repo.tickets.list()).toHaveLength(1)
    expect((await callsSeen()).match(/\/notes/g)).toHaveLength(1)
  }, 40_000)

  it('finishes its turn and posts the answer in one run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-gitlab-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    const calls = await fakes(bin, { todos: [todo] })
    initRepository(root)
    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'), checkout: root,
      gitlab: { enabled: true, host: 'gitlab.example.com', project: 'acme/widgets', cli: join(bin, 'glab'), allowed: ['alice'] },
      executor: { agent: 'codex', binary: join(bin, 'fake-agent'), maxWorkers: 1 },
      assess: { binary: join(bin, 'no-assessor') },
    })
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()

    // A one-round process without `finish` exits while the turn runs; with it, the turn ends and its report goes out.
    await runLoop({ settings, repo, signal: new AbortController().signal, log: () => {}, once: true, finish: true })

    const ticket = repo.tickets.list()[0]!
    expect(ticket.ended?.outcome).toBe('completed')
    expect(await readFile(calls, 'utf8')).toContain('projects/acme%2Fwidgets/issues/7/notes')
  }, 40_000)

  it('ignores a project other than the one this installation watches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-gitlab-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    await fakes(bin, { todos: [{ ...todo, id: 502, project: { path_with_namespace: 'other/repo' } }] })
    initRepository(root)
    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'), checkout: root,
      gitlab: { enabled: true, host: 'gitlab.example.com', project: 'acme/widgets', cli: join(bin, 'glab'), allowed: ['alice'] },
      executor: { agent: 'codex', binary: join(bin, 'fake-agent') },
      assess: { binary: join(bin, 'no-assessor') },
    })
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()
    await round(settings, repo)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(repo.tickets.list()).toHaveLength(0)
  }, 40_000)
})

describe('a GitLab merge request', () => {
  it('is reviewed on its own head and merged with the squash GitLab takes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-gitlab-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    const calls = await fakes(bin, {
      mergeRequests: [mergeRequest],
      report: JSON.stringify({ summary: 'Code is clean, tests passed. DECISION: MERGE', state: 'ready', prs: [] }),
    })
    initRepository(root)
    const settings = SettingsSchema.parse({
      stateDir: join(root, 'state'), checkout: root,
      gitlab: {
        enabled: true, host: 'gitlab.example.com', project: 'acme/widgets', cli: join(bin, 'glab'), allowed: ['alice'],
        mrReview: { enabled: true, pollOpenMrs: true, autoMerge: true, squash: true, verifyCommands: [] },
      },
      executor: { agent: 'codex', binary: join(bin, 'fake-agent'), maxWorkers: 1 },
      assess: { binary: join(bin, 'no-assessor') },
    })
    const repo = new FileRepositories(settings.stateDir)
    await repo.open()

    await round(settings, repo)
    await until(async () => repo.tickets.list().length === 1)
    expect(repo.tickets.list()[0]!.title).toContain('Add a health check')
    const seenCall = async (text: string): Promise<boolean> => (await readFile(calls, 'utf8').catch(() => '')).includes(text)
    await until(async () => (await seenCall('/merge_requests/9/merge')) && (await seenCall('MERGED')), 20_000)

    const recorded = await readFile(calls, 'utf8')
    expect(recorded).toContain('projects/acme%2Fwidgets/merge_requests?state=opened&per_page=100')
    expect(recorded).toContain('projects/acme%2Fwidgets/merge_requests/9/merge --method PUT --field squash=true --field merge_when_pipeline_succeeds=true')
    expect(recorded).toContain('projects/acme%2Fwidgets/merge_requests/9/notes --method POST --raw-field body=')
    expect(recorded).toContain('MERGED')
  }, 40_000)
})

describe('GitLab settings', () => {
  const base = { stateDir: '/tmp/state', checkout: '/tmp/repo' }

  it('defaults the host to gitlab.com and the CLI to glab', () => {
    const settings = SettingsSchema.parse({ ...base, gitlab: { project: 'acme/widgets' } })
    expect(settings.gitlab).toMatchObject({ host: 'gitlab.com', cli: 'glab', project: 'acme/widgets' })
  })

  it('accepts a self-managed host with a port and a project in a subgroup', () => {
    const settings = SettingsSchema.parse({ ...base, gitlab: { host: 'git.example.com:8443', project: 'team/sub/widgets' } })
    expect(settings.gitlab?.host).toBe('git.example.com:8443')
    expect(settings.gitlab?.project).toBe('team/sub/widgets')
  })

  it('refuses a project that is not group/project', () => {
    expect(() => SettingsSchema.parse({ ...base, gitlab: { project: 'widgets' } })).toThrow(/group\/project/)
  })

  it('refuses one installation that serves two forges', () => {
    expect(() => SettingsSchema.parse({
      ...base,
      github: { repository: 'acme/widgets' },
      gitlab: { project: 'acme/widgets' },
    })).toThrow(/one installation serves one forge/)
  })

  it('reads the section from a YAML file, nested merge request review included', () => {
    const settings = SettingsSchema.parse(parseYaml(`stateDir: /tmp/state
checkout: /tmp/repo
gitlab:
  host: git.example.com
  project: acme/widgets
  allowed: [alice, bob]
  mrReview:
    enabled: true
    verifyCommands: ["npm test"]
`))
    expect(settings.gitlab).toMatchObject({
      host: 'git.example.com', project: 'acme/widgets', allowed: ['alice', 'bob'],
      mrReview: { enabled: true, verifyCommands: ['npm test'] },
    })
  })
})

describe('superagent setup gitlab', () => {
  it('writes the host and project from the origin, and the account from glab', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-gitlab-setup-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    await fakes(bin)
    execFileSync('git', ['-C', root, 'init', '-q'])
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://gitlab.example.com/acme/widgets.git'])
    const settings = { ...defaultSettings(root, root), stateDir: join(root, 'state') }
    await writeSettings(join(root, 'settings.yaml'), settings)

    const lines: string[] = []
    const path = process.env.PATH
    // `glab` is named without a path, as a real installation names it, so the stand-in stands in for the one on PATH.
    process.env.PATH = `${bin}${path ? `:${path}` : ''}`
    let code: number
    try {
      code = await setup({ dir: root, targets: ['gitlab'], allow: ['alice'], chat: undefined, stateDir: root, log: line => lines.push(line) })
    } finally { process.env.PATH = path }

    expect(code).toBe(0)
    const written = await readSettings(join(root, 'settings.yaml'))
    expect(written.gitlab).toMatchObject({ enabled: true, host: 'gitlab.example.com', project: 'acme/widgets', allowed: ['alice'] })
    expect(lines.join('\n')).toContain('GitLab account: gitlab-bot (')
    expect(lines.join('\n')).toContain('Project: acme/widgets (private)')
  })
})

describe('the GitLab worker environment', () => {
  it('writes a glab shim and a GitLab credential helper, and no GitHub one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'superagent-gitlab-env-'))
    dirs.push(root)
    await writeEnvironment({ stateDir: root, gitlabCli: '/bin/echo', gitlabHost: 'gitlab.example.com', agentLogin: 'gitlab-bot' }, [])
    expect(await readFile(join(root, 'worker-bin', 'glab'), 'utf8')).toContain("exec '/bin/echo'")
    expect(await readFile(join(root, 'worker-bin', 'gh'), 'utf8')).toContain('no GitHub Source')
    const config = await readFile(join(root, 'worker-gitconfig'), 'utf8')
    expect(config).toContain('[credential "https://gitlab.example.com"]')
    expect(config).toContain('auth git-credential')
    expect(config).not.toContain('github.com')
  })
})

describe('the GitLab origin', () => {
  it('reads the host and project from an https or ssh remote', () => {
    expect(gitlabOrigin('https://gitlab.example.com/acme/widgets.git')).toEqual({ host: 'gitlab.example.com', project: 'acme/widgets' })
    expect(gitlabOrigin('https://gitlab.example.com/team/sub/widgets')).toEqual({ host: 'gitlab.example.com', project: 'team/sub/widgets' })
    expect(gitlabOrigin('git@gitlab.example.com:acme/widgets.git')).toEqual({ host: 'gitlab.example.com', project: 'acme/widgets' })
    expect(gitlabOrigin('ssh://git@gitlab.example.com:2222/acme/widgets.git')).toEqual({ host: 'gitlab.example.com:2222', project: 'acme/widgets' })
  })

  it('is silent about a remote it cannot read', () => {
    expect(gitlabOrigin('/srv/git/widgets.git')).toBeUndefined()
  })
})
