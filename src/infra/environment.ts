/**
 * Writes the CLI shims and the isolated git configuration that bind a run to the agent's accounts.
 *
 * Each shim strips its own directory from PATH before it execs, so a wrapper script that resolves `gh` by name reaches the
 * real binary instead of looping. The git configuration replaces the operator's global configuration for the run, so a
 * worker cannot push with the operator's credentials.
 *
 * These are guardrails, not an OS boundary: a run shares the operator's OS user and can read their home directory.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

const MARKER = '# Written by superagent on every start; edits are lost.'
/** Commands the shims provide, which a blocked list must never shadow. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'glab', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

/** What the shims need: where the state lives and which CLI acts for each Source. */
export interface EnvironmentAccounts {
  stateDir: string
  /** The CLI that acts as the agent's GitHub account, such as `gh-agent`; the git credential helper too. */
  githubCli?: string | undefined
  /** The CLI that acts as the agent's GitLab account, such as `glab-agent`. */
  gitlabCli?: string | undefined
  /** The GitLab instance the credential helper names, such as `git.example.com`. */
  gitlabHost?: string | undefined
  /** The CLI that acts as the Feishu bot, or `undefined` when this installation has none. */
  feishuCli?: string | undefined
  /** The agent's login on the forge, named in the message a blocked command prints. */
  agentLogin?: string | undefined
}

async function written(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.size > 4096) return false
    return (await readFile(file, 'utf8')).includes(MARKER)
  } catch { return false }
}

async function own(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, file)
}

/**
 * Writes the shims and git configuration, refusing to overwrite files it did not write.
 * @throws when a file in the shim directory or at the git configuration path was written by something else.
 */
export async function writeEnvironment(accounts: EnvironmentAccounts, blockedCommands: readonly string[]): Promise<void> {
  const dir = workerBin(accounts.stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) if (!await written(join(dir, name))) throw new Error(`The file ${join(dir, name)} was not written by superagent; move it away or choose another state directory.`)

  // Shims may be read while a run starts, so write each to a temporary file and rename it into place.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, `#!/bin/sh\n${MARKER}\n${body}\n`, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  await shim('gh', accounts.githubCli ? run(accounts.githubCli) : fail('gh is unavailable: this installation has no GitHub Source.'))
  await shim('glab', accounts.gitlabCli ? run(accounts.gitlabCli) : fail('glab is unavailable: this installation has no GitLab Source.'))
  await shim('lark-cli', accounts.feishuCli ? run(accounts.feishuCli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation${accounts.agentLogin ? `; work as ${accounts.agentLogin}` : ''}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))

  await own(workerGitConfig(accounts.stateDir), [
    MARKER,
    // Refuse to commit without an explicit identity instead of guessing one from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    // The forge the worker pushes to, and the CLI that holds its credentials; the other forge's helper is not written.
    ...accounts.gitlabCli && accounts.gitlabHost ? [
      `[credential "https://${accounts.gitlabHost}"]`, `\thelper = ${gitQuote(credentialHelper(accounts.gitlabCli))}`,
      `[url "https://${accounts.gitlabHost}/"]`, `\tinsteadOf = git@${accounts.gitlabHost}:`, `\tinsteadOf = ssh://git@${accounts.gitlabHost}:`,
    ] : [],
    ...accounts.githubCli ? [
      '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(accounts.githubCli))}`,
      '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com:',
    ] : [],
    // The operator's global gitconfig, which usually holds these, is ignored for a run.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Environment variables a run receives, with the shim directory first on PATH. */
export function runEnvironment(accounts: EnvironmentAccounts, variables: Record<string, string>): Record<string, string> {
  return {
    ...variables,
    PATH: [workerBin(accounts.stateDir), process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'].join(delimiter),
    GIT_CONFIG_GLOBAL: workerGitConfig(accounts.stateDir),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}
