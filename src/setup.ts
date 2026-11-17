/**
 * `superagent setup` fills the settings the Sources need from the CLIs that already know the answers.
 *
 * GitHub knows which account `gh` acts as; Feishu knows which chats the bot is in and who is in them. Asking those CLIs
 * removes the step a person would otherwise do by hand — look up a chat id in the Feishu UI, copy every member's open id
 * — so a setup is one command per Source.
 *
 * Nothing is written unless the CLI answered: a failing lookup leaves that section of `settings.yaml` as it was.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readSettings, stringifyYaml, SETTINGS_FILE, type Settings } from './settings.ts'
import { run, runJson, CliError } from './infra/commands.ts'
import { chatMembers } from './sources/feishu.ts'
import { gitlabLogin as gitlabAccount } from './sources/gitlab.ts'

/** What a setup step changed, and what to tell the person about what it did not need to change. */
export interface SetupReport {
  lines: string[]
  /** True when a CLI could not answer, so the person must finish that part by hand. */
  failed: boolean
}

/** The login `gh` acts as, which is the account the agent reads notifications and opens pull requests under. */
export async function githubLogin(cli: string): Promise<string> {
  const user = await runJson<{ login: string }>(cli, ['api', 'user'])
  if (!user.login) throw new CliError(cli, `${cli} api user named no login`, '', '')
  return user.login
}

export interface Repo {
  owner: string
  name: string
  private: boolean
}

/** The repository `github.repository` names, read through the agent's CLI so a private one is found too. */
export async function repositoryMeta(cli: string, repository: string): Promise<Repo> {
  return runJson<Repo>(cli, ['api', `repos/${repository}`, '--jq', '{owner: .owner.login, name: .name, private: .private}'])
}

/** The owner of a checkout path, when that path is a GitHub repository the agent's account can read. */
export async function checkoutRepository(cli: string, origin: string | undefined): Promise<string | undefined> {
  if (!origin) return undefined
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(origin.trim())
  if (!match) return undefined
  try {
    const repo = await repositoryMeta(cli, `${match[1]}/${match[2]}`)
    return `${repo.owner}/${repo.name}`
  } catch { return undefined }
}

/** The remote URL of the clone in `checkout`, as the worktree that `poll` starts from reads it. */
async function originOf(checkout: string, stateDir: string): Promise<string | undefined> {
  const output = await run('git', ['-C', checkout, 'remote', 'get-url', 'origin'], { cwd: stateDir }).catch(() => '')
  return output.trim() || undefined
}

/** A group chat the bot is in, as `lark-cli im +chat-list --as bot` lists it. */
export interface Chat {
  chatId: string
  name: string
}

const ChatSchema = (value: unknown): Chat => {
  const chat = value as { chat_id?: unknown; name?: unknown }
  return { chatId: String(chat.chat_id ?? ''), name: String(chat.name ?? chat.chat_id ?? '') }
}

/**
 * The group chats the bot can hear, which are the only ones it may listen to.
 *
 * `+chat-list` is user-only for direct chats, so this asks for groups only; a bot needs no user login for that.
 */
export async function botChats(cli: string): Promise<Chat[]> {
  const result = await runJson<unknown>(cli, ['im', '+chat-list', '--as', 'bot', '--types', 'group', '--page-all'])
  const listing = result as { items?: unknown[]; chats?: unknown[] }
  const items = Array.isArray(result) ? result : listing?.items ?? listing?.chats ?? []
  return items.map(ChatSchema).filter(chat => chat.chatId)
}

/**
 * The people in a chat, found by their user name rather than by open id.
 *
 * The CLI cannot search users by name through the bot, so `names` is resolved against the members the bot can list: a
 * name matches a member's display name exactly, or, when no member matches, the part of a display name before `@` or
 * a space — which is how a person writes their GitHub name in Feishu. Ids the person typed are kept as they are.
 */
export async function resolveMembers(cli: string, chatId: string, names: readonly string[]): Promise<{ found: string[]; missing: string[] }> {
  if (!names.length) return { found: [], missing: [] }
  // An id is already what the allow list holds, so a list of ids needs no member lookup.
  const found = names.filter(name => name.startsWith('ou_'))
  const wanted = names.filter(name => !name.startsWith('ou_'))
  const missing: string[] = []
  if (!wanted.length) return { found, missing }
  const members = await chatMembers(cli, chatId)
  for (const name of wanted) {
    const match = members.find(member => member.name === name)
      ?? members.find(member => (member.name.split(/[@\s]/)[0] ?? '') === name)
    if (match) found.push(match.id)
    else missing.push(name)
  }
  return { found, missing }
}

/** Splits `a,b, c` and drops the blanks, so one flag can name several people. */
export const names = (value: string | undefined): string[] =>
  (value ?? '').split(',').map(item => item.trim()).filter(Boolean)

export interface SetupOptions {
  dir: string
  /** What to set up; empty means the GitHub and Feishu Sources. */
  targets: readonly ('github' | 'feishu' | 'gitlab')[]
  /** GitHub logins, GitLab usernames or Feishu user names that may ask for work. Empty removes nobody. */
  allow: readonly string[]
  /** A Feishu chat id or name to listen to, instead of reading the settings file. */
  chat: string | undefined
  /** Where `git` runs to read the checkout's origin; the state directory, as `poll` uses it, when given. */
  stateDir: string | undefined
  log: (line: string) => void
}

const MANAGED = ['github', 'feishu', 'gitlab'] as const

/**
 * The settings file with only the Source sections replaced, so this command keeps the text an operator wrote.
 *
 * `writeSettings` writes a whole file and loses every comment; that is fine for `init`, which starts from nothing, but a
 * setup run should leave the rest of the file — the prompt, the rules, the executor — exactly as a person left it.
 */
export function mergeSections(text: string, settings: Settings): string {
  const values: Record<string, unknown> = settings
  const sections = MANAGED.filter(name => values[name] !== undefined)
    .map(name => `${name}:\n${stringifyYaml(values[name], 2)}`)
  const kept: string[] = []
  /** Sections the text did not have; they go after the settings the text does have. */
  const added: string[] = []
  let dropping = false
  let placed = false
  const hold = (section: string): void => { if (placed) added.push(section); else { kept.push(section); placed = true } }
  // A top-level line starts a section; one of the managed names replaces the block it starts, comments and all.
  for (const line of text.split('\n')) {
    if (line && !/^[\s-]/.test(line)) {
      const [name, ...rest] = line.split(':')
      // A nested key may be indented by no space in a file this command writes back; a section names a managed key.
      dropping = MANAGED.includes(name as typeof MANAGED[number]) && rest.length === 1
      if (dropping) hold(sections.shift() ?? '')
    }
    if (!dropping) kept.push(line)
  }
  const body = kept.join('\n').replace(/\n+$/, '')
  return [body, ...sections, ...added].join('\n') + '\n'
}

/** Reads the settings, lets `edit` change them and writes them back when `edit` returns what it wrote. */
async function update(dir: string, edit: (settings: Settings) => Promise<boolean> | boolean): Promise<Settings | undefined> {
  const path = join(dir, SETTINGS_FILE)
  const settings = await readSettings(path)
  if (!await edit(settings)) return undefined
  await writeFile(path, mergeSections(await readFile(path, 'utf8'), settings), 'utf8')
  return settings
}

export async function setupGithub(options: SetupOptions): Promise<SetupReport> {
  const lines: string[] = []
  let failed = false
  let login: string | undefined
  await update(options.dir, async settings => {
    const cli = settings.github?.cli ?? 'gh'
    if (settings.gitlab?.enabled) {
      lines.push('GitHub: this installation already serves GitLab; set `gitlab.enabled` to false before adding GitHub')
      failed = true
      return false
    }
    try { login = await githubLogin(cli) } catch (error) { lines.push(`GitHub: ${(error as Error).message}`); failed = true; return false }
    lines.push(`GitHub account: ${login} (${cli})`)
    const origin = options.stateDir ? await originOf(settings.checkout, options.stateDir) : undefined
    const repository = settings.github?.repository ?? await checkoutRepository(cli, origin)
    try {
      const repo = repository ? await repositoryMeta(cli, repository) : undefined
      // Only what this step made better changes; the rest of the section keeps the values an operator set.
      const github = settings.github = {
        ...settings.github ?? { enabled: true, cli, repository: '', pollSeconds: 60, allowed: [] },
        enabled: settings.github?.enabled ?? true,
        cli,
        repository: repo ? `${repo.owner}/${repo.name}` : settings.github?.repository ?? '',
        allowed: options.allow.length ? [...options.allow] : settings.github?.allowed ?? [],
      }
      lines.push(repo ? `Repository: ${repo.owner}/${repo.name}${repo.private ? ' (private)' : ''}` : 'Repository: not found; set `github.repository`')
      if (!repo) failed = true
      lines.push(`Allowed logins: ${github.allowed.join(', ') || '(none)'}`)
      if (github.allowed.every(item => item.toLowerCase() !== login!.toLowerCase()))
        lines.push(`Note: ${login} is not allowed to ask for work; add it with \`--allow ${login}\` if the agent should answer itself.`)
      return true
    } catch (error) { lines.push(`GitHub: ${(error as Error).message}`); failed = true; return false }
  })
  return { lines, failed }
}

/** The host and project of a GitLab remote URL, in either the https or the ssh form. */
export function gitlabOrigin(origin: string): { host: string; project: string } | undefined {
  const match = /^(?:https?:\/\/([^/]+)\/|ssh:\/\/git@([^/]+)\/|git@([^/]+):)(.+?)(?:\.git)?\/?$/.exec(origin.trim())
  if (!match) return undefined
  const host = (match[1] ?? match[2] ?? match[3] ?? '').replace(/^[^@]+@/, '')
  const project = match[4]
  return host && project ? { host, project } : undefined
}

/** Fills the GitLab Source from `glab` and the checkout's origin, so a self-managed instance is one field. */
export async function setupGitlab(options: SetupOptions): Promise<SetupReport> {
  const lines: string[] = []
  let failed = false
  await update(options.dir, async settings => {
    const cli = settings.gitlab?.cli ?? 'glab'
    if (settings.github?.enabled) {
      lines.push('GitLab: this installation already serves GitHub; set `github.enabled` to false before adding GitLab')
      failed = true
      return false
    }
    const origin = options.stateDir ? await originOf(settings.checkout, options.stateDir) : undefined
    const parsed = origin ? gitlabOrigin(origin) : undefined
    // A host the operator named wins; the schema's `gitlab.com` default does not, so a self-managed checkout fills its own.
    const configuredHost = settings.gitlab?.host
    const host = configuredHost && configuredHost !== 'gitlab.com' ? configuredHost : parsed?.host ?? configuredHost ?? 'gitlab.com'
    const project = settings.gitlab?.project ?? parsed?.project
    if (!project) {
      lines.push('GitLab: no `group/project` in settings and none in the checkout origin; set `gitlab.project`')
      failed = true
      return false
    }
    let login: string
    try { login = await gitlabAccount(cli, host) } catch (error) { lines.push(`GitLab: ${(error as Error).message}`); failed = true; return false }
    lines.push(`GitLab account: ${login} (${cli} on ${host})`)
    try {
      const meta = await runJson<{ path_with_namespace?: string; visibility?: string }>(cli,
        ['api', '--hostname', host, `projects/${encodeURIComponent(project)}`])
      const gitlab = settings.gitlab = {
        ...settings.gitlab ?? { enabled: true, host, project, cli, pollSeconds: 60, allowed: [] },
        enabled: settings.gitlab?.enabled ?? true,
        host,
        cli,
        project: meta.path_with_namespace ?? project,
        allowed: options.allow.length ? [...options.allow] : settings.gitlab?.allowed ?? [],
      }
      lines.push(`Project: ${gitlab.project}${meta.visibility ? ` (${meta.visibility})` : ''}`)
      lines.push(`Allowed users: ${gitlab.allowed.join(', ') || '(none)'}`)
      if (gitlab.allowed.every(item => item.toLowerCase() !== login.toLowerCase()))
        lines.push(`Note: ${login} is not allowed to ask for work; add it with \`--allow ${login}\` if the agent should answer itself.`)
      return true
    } catch (error) { lines.push(`GitLab: ${(error as Error).message}`); failed = true; return false }
  })
  return { lines, failed }
}

async function findChat(cli: string, wanted: string | undefined, current: Settings): Promise<string | undefined> {
  if (wanted?.startsWith('oc_')) return wanted
  const chats = await botChats(cli)
  const known = current.feishu?.chats?.[0]?.chatId
  // An id already in the file is kept even when the listing is poor or names the chat differently.
  if (!wanted && known) return known
  if (!wanted) {
    // One chat is the usual case for a new installation; several need the person to say which.
    return chats.length === 1 ? chats[0]!.chatId : undefined
  }
  return (chats.find(chat => chat.name === wanted) ?? chats.find(chat => chat.name.includes(wanted)))?.chatId
}

export async function setupFeishu(options: SetupOptions): Promise<SetupReport> {
  const lines: string[] = []
  let failed = false
  await update(options.dir, async settings => {
    const cli = settings.feishu?.cli ?? 'lark-cli'
    // A list of open ids names the people exactly, so the chat decides where they may talk and not who they are.
    const idsOnly = options.allow.length > 0 && options.allow.every(name => name.startsWith('ou_'))
    let chatId: string | undefined
    let chats: Chat[] = []
    let listing = ''
    try { chats = await botChats(cli) } catch (error) { listing = (error as Error).message }
    // Without a listing the file can still name a chat; an unreadable listing only stops a chat it has never seen.
    try { chatId = await findChat(cli, options.chat, settings) } catch (error) { listing ||= (error as Error).message }
    // A chat the install already listens to stays; a new one must be one the bot was seen in.
    const known = settings.feishu?.chats?.some(item => item.chatId === chatId) ?? false
    if (chatId && !idsOnly && !known && !chats.some(item => item.chatId === chatId)) {
      lines.push(listing
        ? `Feishu: ${listing}`
        : `Feishu: the bot is in ${chats.length ? chats.map(chat => `${chat.name} (${chat.chatId})`).join(', ') : 'no group chat'}; it cannot listen to ${chatId}.`)
      failed = true
      return false
    }
    if (!chatId) {
      lines.push(listing ? `Feishu: ${listing}` : chats.length
        ? `Feishu: the bot is in ${chats.map(chat => `${chat.name} (${chat.chatId})`).join(', ')}; choose one with \`--chat\`.`
        : 'Feishu: the bot is in no group chat; add it to one, or pass `--chat oc_…`.')
      failed = true
      return false
    }
    const chat = chats.find(item => item.chatId === chatId)
    let allowed = settings.feishu?.allowed ?? []
    if (options.allow.length) {
      const resolved = await resolveMembers(cli, chatId, options.allow).catch(error => { lines.push(`Feishu: ${(error as Error).message}`); failed = true; return { found: [] as string[], missing: [] as string[] } })
      allowed = [...new Set([...allowed, ...resolved.found])]
      if (resolved.missing.length) {
        lines.push(`Feishu: no member of the chat is called ${resolved.missing.join(', ')}; pass their open id (ou_…) or leave the chat members to fill the list with \`syncChat\`.`)
        failed = true
      }
    }
    const feishu = settings.feishu = {
      ...settings.feishu ?? { enabled: true, cli, chats: [], directMessages: true, allowed: [] },
      enabled: settings.feishu?.enabled ?? true,
      cli,
      chats: [{ chatId, name: chat?.name ?? settings.feishu?.chats?.[0]?.name ?? chatId }],
      // Every member may ask, so the list follows the chat instead of drifting from it.
      syncChat: chatId,
      allowed,
    }
    lines.push(`Feishu chat: ${feishu.chats[0]!.name} (${chatId})`)
    lines.push(`Allowed: the chat's members (\`syncChat\`)${allowed.length ? `, and the ${allowed.length} open id(s) listed` : ''}`)
    return true
  })
  return { lines, failed }
}

/** Runs the steps in order and prints what each found; a failed GitHub step still lets Feishu run. */
export async function setup(options: SetupOptions): Promise<number> {
  // A file that already names its forge keeps it: `setup` fills that section instead of switching the installation over.
  const current = await readSettings(join(options.dir, SETTINGS_FILE)).catch(() => undefined)
  const forge = current?.gitlab?.enabled ? 'gitlab' as const : 'github' as const
  const targets: readonly ('github' | 'feishu' | 'gitlab')[] = options.targets.length ? options.targets : [forge, 'feishu']
  let failed = false
  try {
    for (const target of targets) {
      const report = target === 'github' ? await setupGithub(options) : target === 'feishu' ? await setupFeishu(options) : await setupGitlab(options)
      for (const line of report.lines) options.log(line)
      failed ||= report.failed
    }
  } catch (error) {
    options.log((error as Error).message)
    return 1
  }
  options.log('')
  options.log(`Wrote ${join(options.dir, SETTINGS_FILE)}. Next: \`superagent doctor\`, then \`superagent poll\`.`)
  return failed ? 1 : 0
}
