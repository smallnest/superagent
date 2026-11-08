/** How long a reply in a conversation may be: a person reads it on a phone, and the evidence belongs in the pull request. */
const REPLY_MAX = 200

/** The first sentence of a report summary, short enough to send; the record keeps every word. */
export function deliverable(summary: string): string {
  const one = summary.replace(/\s+/g, ' ').trim()
  // A full stop, question or exclamation mark ends an English sentence only with a space after it, so "v1.2" and
  // "README.md" stay whole.
  // Chinese and Japanese sentences need no space after their mark, so those marks end a sentence on their own.
  const sentence = one.split(/(?<=[.!?])\s|(?<=[\u3002\uff01\uff1f])/)[0] ?? ''
  const text = (sentence || one).replace(/[\s.!?\u3002\uff01\uff1f]+$/, '')
  return text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX - 1).trimEnd()}…` : text || 'The work is done.'
}

function deliver(engine: Engine, repo: FileRepositories, delivered: Set<string>, log: (line: string) => void): void {
  for (const ticket of repo.tickets.list()) {
    const report = latestReport(ticket)
    // A ready report ends its ticket, so the conversation that asked gets its answer once the ticket is no longer live.
    if (!ticket.ended || report?.state !== 'ready' || delivered.has(`${ticket.id}@${report.at}`)) continue
    delivered.add(`${ticket.id}@${report.at}`)
    const text = deliverable(String(report.summary))
    try {
      engine.reply({ purpose: 'result', ticketId: ticket.id, text })
      log(`Answered ticket ${ticket.id} in its conversation`)
    } catch (error) {
      log(`Could not answer ticket ${ticket.id}: ${(error as Error).message}`)
    }
  }
}

/** The outcome of a finished agent turn, which a round records on the Engine. */
type Finished = { ticketId: string; report: { state: string; summary: string; question?: string | null } }

/** Holds outcomes that arrive while no round is listening, and wakes a round to record them. */
class WorkQueue<T> {
  private readonly items: T[] = []
  private waiter: (() => void) | undefined
  /** An outcome that arrived; it is kept even with no round waiting, so one that outlives its round is still recorded. */
  push(item: T): void { this.items.push(item); this.wake() }
  /** What arrived since the last drain. */
  drain(): T[] { return this.items.splice(0) }
  /** Whether an outcome waits to be recorded. */
  ready(): boolean { return this.items.length > 0 }
  /** Settles when an outcome arrives, or when `ms` passes. */
  wait(ms: number): Promise<void> {
    if (this.items.length) return Promise.resolve()
    return new Promise<void>(resolve => {
      const finish = (): void => { clearTimeout(timer); this.waiter = undefined; resolve() }
      const timer = setTimeout(finish, ms)
      this.waiter = finish
    })
  }
  private wake(): void { this.waiter?.() }
}

/** How long one round waits for an outcome before the next round; one that arrives is recorded at once, not several rounds later. */
const TURN_WAIT_MS = 1000

/** Records the assessments that finished as Decisions; one the Engine refuses is logged, not thrown. */
function decide(engine: Engine, decided: Decided[], log: (line: string) => void): void {
  for (const { triggerId, outcome } of decided) {
    try {
      const made = engine.decide(triggerId, outcome)
      log(`Decided ${triggerId}: ${made.kind}${made.ticketId ? `, ticket ${made.ticketId}` : ''}${made.reason?.length ? ` — ${JSON.stringify(made.reason)}` : ''}`)
    } catch (error) { log(`Could not decide ${triggerId}: ${(error as Error).message}`) }
  }
}

/** Records the turns that finished, so a ticket ends without the loop holding work in memory; a refused report is logged, not thrown. */
function record(engine: Engine, repo: FileRepositories, finished: Finished[], log: (line: string) => void): void {
  for (const item of finished) {
    // A report the Engine refuses, such as one for a ticket a person already stopped, must not stop the others.
    try {
      // The ticket in the Engine's memory may be older than the one on disk: the agent's turn takes minutes, and other
      // rounds wrote to the disk in between.
      const latest = repo.tickets.get(item.ticketId)
      if (latest) engine.updateTicket(latest)
      engine.report(item.ticketId, { state: item.report.state as 'ready', summary: item.report.summary,
        ...item.report.question ? { question: item.report.question } : {} })
    } catch (error) { log(`Could not record the report for ${item.ticketId}: ${(error as Error).message}`) }
  }
}

/** Posts the messages the Engine queued, one comment per message. */
async function send(channel: Outbox & { drain: () => OutboundMessage[] }, clis: { github?: string; feishu?: string }, log: (line: string) => void): Promise<void> {
  for (const message of channel.drain()) {
    if (message.channel.source === 'feishu') {
      const address = message.channel.address as { chatId?: string; messageId?: string }
      if (!clis.feishu) { log(`Cannot answer in ${address.chatId}: the Feishu Source is off`); continue }
      try {
        await reply(clis.feishu, address.messageId!, message.text, message.id)
        log(`Answered in ${address.chatId}`)
      } catch (error) { log(`Could not answer in ${address.chatId}: ${(error as Error).message}`) }
      continue
    }
    const address = message.channel.address as { repository?: string; number?: string }
    if (!address.number || !address.repository) continue
    if (!clis.github) { log(`Cannot post on ${address.repository}#${address.number}: the GitHub Source is off`); continue }
    try {
      await run(clis.github, ['api', `repos/${address.repository}/issues/${address.number}/comments`, '-f', `body=${message.text}`])
      log(`Posted a message on ${address.repository}#${address.number}`)
    } catch (error) { log(`Could not post on ${address.repository}#${address.number}: ${(error as Error).message}`) }
  }
}

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Engine, type Executor, type Outbox, type OutboundMessage, type Ticket, type Trigger, type Assignment, latestReport } from './core/index.ts'
import { runnerFor, type AgentName, type AgentReport, type AgentRunner } from './agents/index.ts'
import { writeEnvironment, runEnvironment, type EnvironmentAccounts } from './infra/environment.ts'
import { run } from './infra/commands.ts'
import type { FileRepositories } from './state/files.ts'
import type { Settings } from './settings.ts'
import { composePrompt, standingRules } from './prompts.ts'
import { buildPolicy, sourceScope } from './policy.ts'
import { claudeAssessor } from './assess.ts'
import { assessing, type Decided } from './assessing.ts'
import { agentLogin, pollNotifications } from './sources/github.ts'
import { botIdentity, chatMembers, consumeEvents, feishuTrigger, reply, type StreamHandle } from './sources/feishu.ts'
import { prepareWorktree, ticketBranch } from './infra/worktree.ts'

/** Where the loop keeps its own bookkeeping, beside the domain state. */
const pollKey = 'github:poll'
const seenKey = (id: string) => `github:seen:${id}`

/** Lines one round reads from the stream at most, so a chat that keeps talking does not hold a round open. */
const MAX_LINES = 500

/** A failed save of the last round must not stop the next one. */
function outbox(): Outbox {
  const messages = new Map<string, OutboundMessage>()
  return {
    send: message => { if (!messages.has(message.id)) messages.set(message.id, message) },
    status: id => messages.has(id) ? 'pending' : undefined,
    withdraw: id => { messages.delete(id) },
    /** Everything queued so far, for the caller to deliver in order. */
    drain: () => [...messages.values()].sort((a, b) => a.id.localeCompare(b.id)),
  } as Outbox & { drain: () => OutboundMessage[] }
}

/**
 * Runs a ticket on the configured agent.
 *
 * The Engine calls `start` and expects a report through its own callbacks; this keeps the work asynchronous, so the loop
 * never blocks on an agent turn.
 */
class AgentExecutor implements Executor {
  private readonly active = new Map<string, AbortController>()
  constructor(private readonly options: {
    settings: Settings
    runner: AgentRunner
    stateDir: string
    repository: string
    agent: string
    accounts: EnvironmentAccounts
    /** The Feishu CLI that acts as the bot, when the Feishu Source is on; its shim goes into the agent's environment. */
    feishuCli?: string
    engine: Engine
    site: { started(ticketId: string, assignmentId: string): void; reported(ticketId: string, report: { state: string; summary: string; question?: string | null }): void
      failed(ticketId: string, assignmentId: string, summary: string): void }
    prompt: (ticket: Ticket, directory: string, branch?: string) => Promise<string>
  }) {}

  start(ticket: Ticket, assignment: Assignment): void {
    const controller = new AbortController()
    // The start is the fact the round records; recording it inside the start keeps the running state from R1 from
    // outliving the start in the order R2 reads it, because the engine's memory is the last word a round sees.
    const { site } = this.options
    site.started(ticket.id, assignment.id)
    this.active.set(ticket.id, controller)
    // The turn begins after the current round: the round records "started" first, so the report then lands on the running
    // assignment instead of on one the Engine has not been told about yet.
    void this.execute(ticket, assignment, controller)
  }

  deliver(): void {
    // A ticket runs one turn at a time; a message that arrives mid-turn is read at the next start.
  }

  /** The Engine's memory of the ticket, so the report lands on a ticket that already holds this round's changes to it. */
  refresh(ticket: Ticket): void { this.options.engine.updateTicket(ticket) }

  stop(ticket: Ticket): void {
    this.active.get(ticket.id)?.abort()
    this.active.delete(ticket.id)
  }

  private async execute(ticket: Ticket, assignment: Assignment, controller: AbortController): Promise<void> {
    const { settings, runner, stateDir, accounts, feishuCli, site } = this.options
    const directory = ticket.execution?.directory ?? join(stateDir, 'work', ticket.id)
    try {
      // Each ticket gets its own branch off the checkout's HEAD, so tickets never share a working tree or a branch.
      const branch = ticketBranch(settings.branchPrefix, ticket.title, ticket.id)
      await prepareWorktree({ checkout: settings.checkout, directory, branch, signal: controller.signal })
      if (settings.executor.prepare) await run('/bin/sh', ['-c', settings.executor.prepare], { env: this.variables(ticket, directory, branch), timeoutMs: 120_000 })
      const prompt = await this.options.prompt(ticket, directory, branch)
      const result = await runner.run({
        prompt,
        cwd: directory,
        env: runEnvironment(feishuCli ? { ...accounts, feishuCli } : accounts, this.variables(ticket, directory, branch)),
        signal: controller.signal,
        timeoutMs: settings.executor.timeoutMinutes * 60_000,
        model: settings.executor.model,
      })
      const report = result.report ?? inferReport(result.finalText, result.ok)
      await appendLog(directory, prompt, result.raw.slice(-20_000), report)
      site.reported(ticket.id, { state: report.state ?? (result.ok ? 'ready' : 'failed'), summary: report.summary, question: report.question ?? null })
    } catch (error) {
      site.failed(ticket.id, assignment.id, `The agent could not run: ${(error as Error).message}`)
    } finally { this.active.delete(ticket.id) }
  }

  private variables(ticket: Ticket, directory: string, branch: string): Record<string, string> {
    const trigger = ticket.origin
    return {
      SUPERAGENT_TICKET: ticket.id,
      SUPERAGENT_DIR: directory,
      SUPERAGENT_BRANCH: branch,
      SUPERAGENT_REPOSITORY: this.options.repository,
      SUPERAGENT_TRIGGER: trigger.triggerId,
      DSH_SUPERAGENT_DIR: directory,
      DSH_SUPERAGENT_TICKET: ticket.id,
      DSH_SUPERAGENT_GITHUB_REPOSITORY: this.options.repository,
    }
  }
}

/** Turns an agent that wrote no report into one the Engine can still act on. */
function inferReport(text: string, ok: boolean): AgentReport {
  return {
    summary: text.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 500) || (ok ? 'The agent finished.' : 'The agent failed.'),
    state: ok ? 'ready' : 'failed',
  }
}

async function appendLog(directory: string, prompt: string, raw: string, report: AgentReport): Promise<void> {
  const path = join(directory, '.superagent', 'log.md')
  const entry = ['', `## ${new Date().toISOString()}`, '', '**Report**', '', '```json', JSON.stringify(report, null, 2), '```', '', '**Agent output**', '', '```', raw, '```'].join('\n')
  const previous = await readFile(path, 'utf8').catch(() => '')
  await mkdir(join(directory, '.superagent'), { recursive: true }).then(() => writeFile(path, `${previous}${entry}\n`))
}

export interface LoopOptions {
  settings: Settings
  repo: FileRepositories
  signal: AbortSignal
  log: (line: string) => void
  /** Run one round and return, instead of waiting for the poll interval. */
  once?: boolean
}

/**
 * The loop that makes an installation run without a person: poll the Sources, assess what they bring, and run the tickets
 * the assessment accepts.
 *
 * It is a plain async loop, not a daemon protocol: `runLoop` returns when its signal aborts, so a cron job, a shell script,
 * or a coding agent can each call it for one round with `--once`.
 */
/** Runs rounds until `signal` aborts; each round polls, assesses, and starts the tickets accepted. */
export async function runLoop(options: LoopOptions): Promise<void> {
  // A round on demand ends by itself: the event stream stops with the last round, so the caller's process can exit.
  const { settings, repo, signal: caller, log } = options
  const stop = new AbortController()
  if (!options.once) caller.addEventListener('abort', () => stop.abort(), { once: true })
  const signal = stop.signal
  const github = settings.github?.enabled ? settings.github : undefined
  const feishu = settings.feishu?.enabled ? settings.feishu : undefined
  if (!github && !feishu) throw new Error('No Source is on in settings.yaml; nothing to poll.')
  const login = github ? await agentLogin(github.cli, signal) : ''
  // Without a GitHub Source the shims point at nothing usable; every GitHub action then fails inside the run, which is right.
  const accounts = { stateDir: settings.stateDir, githubCli: github?.cli ?? 'gh', agentLogin: login } as EnvironmentAccounts
  await writeEnvironment(accounts, settings.executor.blockedCommands)
  const standing = await standingRules()

  const channel = outbox() as Outbox & { drain: () => OutboundMessage[] }
  const scope = sourceScope(settings)
  // Finished turns wait here for a round to record them, and wake the loop's idle wait so it happens at once.
  const decided = new WorkQueue<Decided>()
  const finished = new WorkQueue<Finished>()
  const engine = new Engine({
    repo,
    policy: () => buildPolicy(settings, scope),
    scope,
    assessor: assessing({ settings: () => settings, next: claudeAssessor(settings), decided, log }),
    executor: undefined as unknown as Executor,
    outbox: channel,
  })
  // Handed as a value: after the optional `...feishu ? {...} : {}` spread, an argument list that follows continues the
  // spread's sequence expression, so an object literal there lands only in the spread's true branch. A reported turn is
  // recorded here, as well as by the round: a turn lasts several rounds of a one-round-at-a-time loop, and the round that
  // hears of it may never reach its own record step.
  const site = {
    started: (ticketId: string, assignmentId: string) => engine.assignmentStarted(ticketId, assignmentId),
    reported: (ticketId: string, report: { state: string; summary: string; question?: string | null }) => {
      record(engine, repo, [{ ticketId, report }], log)
    },
    failed: (ticketId: string, _assignmentId: string, summary: string) => finished.push({ ticketId, report: { state: 'failed', summary } }),
  }
  const executor = new AgentExecutor({
    engine, settings, runner: runnerFor(settings.executor.agent as AgentName, settings.executor.binary), stateDir: settings.stateDir,
    repository: github?.repository ?? settings.checkout, agent: login, accounts, ...feishu ? { feishuCli: feishu.cli } : {},
    site,
    prompt: async (ticket, directory, branch) => {
      const trigger = repo.triggers.get(ticket.origin.triggerId)
      const source = trigger?.source === 'feishu' ? 'feishu' as const : 'github' as const
      return composePrompt({ ticket, trigger, repository: github?.repository ?? settings.checkout, agentLogin: login, branchPrefix: settings.branchPrefix,
        source, instructions: settings.prompts, branch, standing })
    },
  })
  // `syncChat` copies a chat's members into the allow list each round, so a person joins by joining the chat. The list
  // grows in the Engine's memory only: a restart reads it from settings again and the sync adds them back.
  const admitted = new Set<string>()
  const sync = (): Promise<void> => !feishu?.syncChat ? Promise.resolve() : chatMembers(feishu.cli, feishu.syncChat, signal)
    .then(members => {
      const listed = feishu.allowed.map(id => id.toLowerCase())
      const add = members.map(member => member.id).filter(id => !listed.includes(id.toLowerCase()) && !admitted.has(id.toLowerCase()))
      if (add.length) { feishu.allowed.push(...add); for (const id of add) admitted.add(id.toLowerCase()); log(`Admitted ${add.length} member(s) of ${feishu.syncChat} from its chat`) }
    })
    .catch(error => { if (!signal.aborted) log(`Could not read the members of ${feishu.syncChat}: ${(error as Error).message}`) })
  await sync()
  // Feishu pushes events, so the stream runs beside the rounds; it only stores what it receives, and a round decides.
  const chats = new Map((feishu?.chats ?? []).map(chat => [chat.chatId, false] as const))
  // The bot's own ids make a mention match, but reading them takes a CLI call, and the stream must be listening before a
  // message is pushed. So the consumer does not wait for them: an empty bot id matches every mention, and a message read
  // before the ids arrive is matched with what they are once they do. A failure is logged once, not once per round.
  let identity = Promise.resolve({ appId: '', botId: '' })
  let read = false
  const identify = (): void => {
    // Read once per run: the ids do not change, and the stream goes on matching with what it has.
    if (read) return
    read = true
    identity = botIdentity(feishu!.cli, [...new Set([...chats.keys(), ...feishu!.syncChat ? [feishu!.syncChat] : []])], signal).catch(error => {
      if (!signal.aborted) log(`Could not read the bot's ids: ${(error as Error).message}`)
      return { appId: '', botId: '' }
    })
  }
  const store = (trigger: Trigger): void => {
    // Stored at once rather than in a round, so a message that arrives while a round waits for its interval is not lost.
    try {
      const result = repo.atomic(() => engine.receive(trigger))
      // A round flushes the disk itself; flushing here while a round reads would rewrite this file after the message was
      // taken, and the next round would read it as a new one.
      if (result !== 'duplicate') log(`Received ${trigger.id} from ${trigger.actor.id} on ${trigger.threads[0]!.id}`)
    } catch (error) { log(`Could not store ${trigger.id}: ${(error as Error).message}`) }
  }
  const receive = (event: unknown): void => {
    void identity.then(bot => feishuTrigger(event, { botAppId: bot.appId, botId: bot.botId, chats, directMessages: feishu?.directMessages ?? true,
      onInvalid: error => log(`Ignored an event: ${error}`) }))
      .then(trigger => { if (trigger) store(trigger) })
      .catch(error => { log(`Could not store an event: ${(error as Error).message}`) })
  }
  // A consumer runs for the whole round loop, not for one round: Feishu pushes a message to the stream, and a stream that
  // stops and starts between rounds drops what is sent while it is down. The rounds read what it stored between their steps.
  let handle: StreamHandle | undefined
  // A run in one process, such as a round on demand, starts its stream again while the process lives; one that ends with the
  // round also ends its stream, or the process that started it never exits.
  const stopListening = new AbortController()
  if (options.once) caller.addEventListener('abort', () => stopListening.abort(), { once: true })
  if (feishu) {
    handle = consumeEvents({ cli: feishu.cli, signal: stopListening.signal,
      onMessage: receive,
      onListening: (started) => { handle = started },
      ...options.once ? {} : { onEnded: () => stopListening.abort() },
      // A consumer that could not start is a warning for the log; one that ends with an error is a line in the log, and the
      // next round starts another.
      onError: message => { if (!signal.aborted) log(message) },
    })
  }
  /** Waits for the stream's next line: a line that arrives settles it, and a stream that answers nothing is idle. */
  const nextLine = (): Promise<boolean> => handle ? handle.next(settings.executor.streamIdleMs) : Promise.resolve(false)
  const delivered = new Set<string>()
  // The Engine takes its Executor at construction and the Executor reports back through the Engine, so the two are joined
  // here. A turn that finished while no round is listening is also recorded from here: a turn lasts several rounds of a
  // loop that runs one round at a time, and the round that hears of it may never reach its own record step.
  ;(engine as unknown as { options: { executor: Executor } }).options.executor = executor

  // Triggers a round has taken: they stay on disk as history, and the Engine's memory keeps that they were taken.
  const inRound = new Set<string>()
  // Rounds read the state from disk, so a message stored by the stream has to be moved into the Engine's memory first.
  const ingest = (): void => {
    const waiting = repo.triggers.list().filter(trigger => trigger.source === 'feishu')
    // Stored triggers stay on disk as history, so the Engine's own duplicate check is what skips the ones already taken.
    for (const trigger of waiting) { inRound.add(trigger.id); engine.receive(trigger) }
  }
  let since = (repo.getMeta<string>(pollKey) ?? new Date().toISOString())
  // Reads what the stream sent during a round, so a message that arrives while a round works is not lost. A consumer that
  // has not started yet answers at once, and the round goes on with what the state has.
  const pull = async (): Promise<void> => {
    if (!feishu) return
    // Bounded: a chat that keeps talking must not keep one round going, since the next round reads the rest.
    for (let lines = 0; lines < MAX_LINES && !signal.aborted; lines++) {
      // The `await` is first on purpose: `x && await y()` never calls `y` when `x` is true.
      if (!await nextLine()) break
    }
    if (signal.aborted) return
    ingest()
    await repo.reload()
  }
  while (!signal.aborted) {
    const round = new Date().toISOString()
    try {
      if (feishu) identify()
      // Ingested before the reload, so this round decides on a message that arrived during it; the next round sees the rest.
      ingest()
      await repo.reload()
      await pull()
      if (github) {
        const triggers = await pollNotifications({
          cli: github.cli, repository: github.repository, agent: login, since, signal,
          seen: id => repo.getMeta<boolean>(seenKey(id)) === true,
          mark: id => repo.setMeta(seenKey(id), true),
        })
        for (const trigger of triggers) {
          const result = engine.receive(trigger)
          if (result !== 'duplicate') log(`Received ${trigger.id} from ${trigger.actor.id} on ${trigger.threads[0]!.id}`)
        }
        since = round
        repo.setMeta(pollKey, since)
      }
      // The Engine queues an Eval per new thread; running it hands an unaddressed candidate to the assessor.
      engine.evaluateDue()
      decide(engine, decided.drain(), log)
      record(engine, repo, finished.drain(), log)
      // A line that arrives while an agent runs is stored by its handler, so `flush` writes it with the round.
      await repo.flush()
      await pull()
      inRound.clear()
      // The report goes back to where the person asked before any other message, so the answer reads as the outcome.
      deliver(engine, repo, delivered, log)
      await repo.flush()
      await send(channel, { ...github ? { github: github.cli } : {}, ...feishu ? { feishu: feishu.cli } : {} }, log)
      await repo.flush()
      await sync()
    } catch (error) {
      if (!signal.aborted) log(`Round failed: ${(error as Error).message}\n${(error as Error).stack?.split('\n').slice(1, 4).join('\n')}`)
    }
    if (options.once) break
    // A turn that ends during the wait is recorded by the next round, which starts at once instead of at the interval;
    // a GitHub Source with a longer interval waits in the same way, and the Source's own timer adds nothing to it.
    const seconds = Math.min(github?.pollSeconds ?? Infinity, feishu ? 15 : Infinity)
    // Only a loop that runs for long waits between rounds; one round on demand ends here, so its timeout has nothing to wake.
    let left = options.once ? 0 : seconds * 1000
    while (left > 0 && !signal.aborted) {
      const began = Date.now()
      const wait = Math.max(1, Math.min(TURN_WAIT_MS, left))
      await Promise.race([Promise.race([finished.wait(wait), decided.wait(wait)]),
        new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))])
      // A turn woke the wait: the round it woke starts now, and the Sources are read as early as they can be.
      if (finished.ready() || decided.ready()) break
      left -= Date.now() - began
    }
  }
  // The stream starts with the first round, and a stream that ended starts again with the next one, so it lives past a round
  // on demand: a consumer the last round stops loses what Feishu pushes until another round starts. It ends with the whole
  // run, in its own time so the process that started it can exit after its last round.
  stop.abort()
  // A process that ran one round leaves nothing behind: a consumer or the agent's shim a round started holds the event
  // loop open until it ends, and one whose removal needs an event-loop turn ends on the next one, from the top-level check.
  if (options.once) setImmediate(() => process.exit(process.exitCode ?? 0))
}
