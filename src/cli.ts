/**
 * `superagent` command line: create an installation, inspect it, and run one ticket by hand.
 *
 * The command prints Markdown because people and agents both read it: an agent that needs to know what is open runs
 * `superagent status` and gets an answer it can put straight into a prompt.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import { AGENT_NAMES, installed, reportInstructions, runnerFor, type AgentName } from './agents/index.ts'
import { readState, FileRepositories } from './state/files.ts'
import { runLoop } from './runner.ts'
import { reasonText } from './core/index.ts'
import { defaultSettings, readSettings, SETTINGS_FILE, writeSettings } from './settings.ts'

const USAGE = `superagent — an agent that turns GitHub and Feishu requests into tickets

  superagent init [dir]            create ${SETTINGS_FILE} and the state directory in dir (default: .)
  superagent status [dir]          print open tickets and recent activity as Markdown
  superagent doctor [dir]          show which coding agents are installed and which one is selected
  superagent agents                list the coding agents a configuration may name
  superagent run <dir> -p <text>   run one prompt on the configured agent, in a directory it names
  superagent poll [dir] [--once]   poll the Sources and run the tickets they bring, once or until interrupted

Every command that reads an installation takes the directory that holds ${SETTINGS_FILE}.`

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/** The state directory a settings file names, or the default when there is no settings file. */
async function stateDirOf(dir: string): Promise<string> {
  try { return (await readSettings(join(dir, SETTINGS_FILE))).stateDir } catch { return join(dir, 'state') }
}

async function init(dir: string): Promise<number> {
  const path = join(dir, SETTINGS_FILE)
  // A second run in the same directory keeps the state it already has.
  if (await exists(path)) {
    const current = await readSettings(path)
    await mkdir(current.stateDir, { recursive: true })
    await new FileRepositories(current.stateDir).open()
    process.stdout.write(`${path} already exists; kept its settings and state at ${current.stateDir}.\n`)
    return 0
  }
  const settings = defaultSettings(resolve(dir), homedir())
  await writeSettings(path, settings)
  await mkdir(settings.stateDir, { recursive: true })
  await new FileRepositories(settings.stateDir).open()
  process.stdout.write([
    `Created ${path}.`,
    '',
    `State lives in ${settings.stateDir}.`,
    '',
    'Next: set `github.repository` and `github.allowed`, choose `executor.agent`, then run `superagent doctor`.',
    '',
  ].join('\n'))
  return 0
}

async function status(dir: string): Promise<number> {
  const { tickets, threads, decisions, triggers: all, exists: found } = await readState(await stateDirOf(dir))
  const triggers = new Map(all.map(trigger => [trigger.id, trigger]))
  if (!found) {
    process.stdout.write(`No state directory yet. Run \`superagent init\` first.\n`)
    return 1
  }
  const open = tickets.filter(ticket => ticket.ended === undefined)
  const done = tickets.filter(ticket => ticket.ended !== undefined)
  const lines = [`# Superagent status`, '', `Open tickets: ${open.length} · Ended: ${done.length} · Threads: ${threads.length}`, '']
  if (open.length) {
    lines.push('## Open', '')
    for (const ticket of open) {
      const latest = ticket.assignments.at(-1)
      const state = latest ? latest.state : 'no assignment'
      const question = ticket.attention ? ` — waiting on: ${ticket.attention.question}` : ''
      lines.push(`- \`${ticket.id}\` **${ticket.title}** (${state})${question}`)
    }
    lines.push('')
  }
  if (done.length) {
    lines.push('## Ended', '')
    for (const ticket of done.slice(-10)) lines.push(`- \`${ticket.id}\` ${ticket.title} — ${ticket.ended?.outcome} by ${ticket.ended?.by}`)
    lines.push('')
  }
  if (!tickets.length) lines.push('No tickets yet.', '')
  // An unaddressed message is assessed in every mode; `observe` records what `auto` would accept here, so a person can
  // read the judgements before any of them starts work.
  const judged = decisions.filter(decision => decision.strength === 'inferred').sort((a, b) => a.at.localeCompare(b.at)).slice(-10)
  if (judged.length) {
    lines.push('## Unaddressed messages', '')
    for (const decision of judged) {
      const message = decision.triggerIds.map(id => triggers.get(id)?.text ?? '').join(' ')
      const what = decision.ticketId ? `ticket \`${decision.ticketId}\`` : decision.kind
      lines.push(`- ${decision.at} **${what}** — ${reasonText(decision.reason)}${message ? ` — “${message.replace(/\s+/g, ' ').slice(0, 80)}”` : ''}`)
    }
    lines.push('')
  }
  process.stdout.write(lines.join('\n'))
  return 0
}

async function doctor(dir: string): Promise<number> {
  let settings
  try { settings = await readSettings(join(dir, SETTINGS_FILE)) } catch (error) { process.stderr.write(`${(error as Error).message}\n`); return 1 }
  const found = await installed()
  const lines = ['# Superagent doctor', '', '| Agent | Installed |', '| --- | --- |']
  for (const name of AGENT_NAMES) lines.push(`| ${name} | ${found[name] ? 'yes' : 'no'} |`)
  const chosen = settings.executor.agent as AgentName
  lines.push('', `Selected: **${chosen}**${found[chosen] ? '' : ' — not installed'}`, '')
  if (settings.github) lines.push(`Repository: \`${settings.github.repository}\`, allowed logins: ${settings.github.allowed.join(', ') || '(none)'}`, '')
  const stateFound = await exists(settings.stateDir)
  lines.push(`State directory: \`${settings.stateDir}\`${stateFound ? '' : ' — missing, run `superagent init`'}`, '')
  process.stdout.write(lines.join('\n'))
  return found[chosen] ? 0 : 1
}

/** Runs one prompt on the configured agent and prints the report, which is how a person tests an installation. */
async function runOne(dir: string, prompt: string): Promise<number> {
  const settings = await readSettings(join(dir, SETTINGS_FILE))
  const runner = runnerFor(settings.executor.agent as AgentName, settings.executor.binary)
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())
  const result = await runner.run({
    prompt: `${prompt}\n${reportInstructions()}`,
    cwd: resolve(dir),
    env: { ...process.env as Record<string, string> },
    signal: controller.signal,
    timeoutMs: settings.executor.timeoutMinutes * 60_000,
  })
  process.stdout.write(`${result.report?.summary ?? result.finalText}\n`)
  if (!result.ok) process.stderr.write(`The agent exited ${result.exitCode}.\n`)
  return result.ok ? 0 : 1
}

/** Runs the loop for one round or until interrupted, holding the state directory's lock for the whole run. */
async function poll(dir: string, once: boolean): Promise<number> {
  let settings
  try { settings = await readSettings(join(dir, SETTINGS_FILE)) } catch (error) { process.stderr.write(`${(error as Error).message}\n`); return 1 }
  const repo = new FileRepositories(settings.stateDir)
  await repo.open()
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())
  const log = (line: string): void => { process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`) }
  try {
    await runLoop({ settings, repo, signal: controller.signal, log, ...once ? { once: true } : {} })
    return 0
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  } finally { await repo.flush() }
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  const dirOf = (index: number): string => rest[index] && !rest[index]!.startsWith('-') ? resolve(rest[index]!) : process.cwd()
  switch (command) {
    case 'init': return init(rest[0] ? resolve(rest[0]) : process.cwd())
    case 'status': return status(dirOf(0))
    case 'doctor': return doctor(dirOf(0))
    case 'agents': process.stdout.write(`${AGENT_NAMES.join('\n')}\n`); return 0
    case 'poll': return poll(dirOf(0), rest.includes('--once'))
    case 'run': {
      const index = rest.indexOf('-p')
      if (index < 0 || !rest[index + 1]) { process.stderr.write(USAGE + '\n'); return 2 }
      return runOne(dirOf(0), rest[index + 1]!)
    }
    case undefined: case '-h': case '--help': case 'help': process.stdout.write(USAGE + '\n'); return command ? 0 : 2
    default: process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`); return 2
  }
}


