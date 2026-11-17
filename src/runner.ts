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
      const reply = engine.reply({ purpose: 'result', ticketId: ticket.id, text })
      // An earlier run may have posted it already; the outbox knows, and says so instead of sending it again.
      if (!reply.reused) log(`Answered ticket ${ticket.id} in its conversation`)
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
async function send(
  channel: Outbox & { drain: () => OutboundMessage[] },
  clis: { github?: string; gitlab?: { cli: string; host: string }; feishu?: string; twitter?: string },
  log: (line: string) => void,
  attentionConfig?: Settings['attention'],
  /** Records that a message went out, so a later round or process does not post it again. */
  sent?: (id: string) => void,
): Promise<void> {
  const quiet = isQuietHours(new Date(), attentionConfig?.quietHours)
  const present = await isUserPresent(attentionConfig?.idleSecondsThreshold)
  const done = (message: OutboundMessage): void => { channel.withdraw(message.id); sent?.(message.id) }
  for (const message of channel.drain()) {
    if (message.channel.source === 'twitter') {
      const address = message.channel.address as { tweetUrl?: string; tweetId?: string }
      if (!clis.twitter) { log(`Cannot answer on Twitter: the Twitter Source is off`); continue }
      if (!address.tweetUrl) continue
      try {
        await replyTweet(clis.twitter, address.tweetUrl, message.text)
        log(`Replied to tweet ${address.tweetUrl}`)
        done(message)
      } catch (error) { log(`Could not reply to tweet ${address.tweetUrl}: ${(error as Error).message}`) }
      continue
    }
    if (message.channel.source === 'feishu') {
      const address = message.channel.address as { chatId?: string; messageId?: string }
      if (!clis.feishu) { log(`Cannot answer in ${address.chatId}: the Feishu Source is off`); continue }
      if (quiet && message.kind !== 'acknowledgement') {
        log(`Quiet hours active (23:00-08:00); answered in ${address.chatId} quietly`)
      } else if (present) {
        log(`User is present at computer; answered in ${address.chatId}`)
      } else {
        log(`User is away; dispatched notification to mobile in ${address.chatId}`)
      }
      try {
        await reply(clis.feishu, address.messageId!, message.text, message.id)
        done(message)
      } catch (error) { log(`Could not answer in ${address.chatId}: ${(error as Error).message}`) }
      continue
    }
    if (message.channel.source === 'gitlab') {
      const address = message.channel.address as { host?: string; project?: string; number?: string; kind?: string }
      if (!clis.gitlab) { log(`Cannot post on ${address.project}: the GitLab Source is off`); continue }
      if (!address.project || !address.number) continue
      const kind = address.kind === 'merge_request' ? 'merge_request' as const : 'issue' as const
      const url = `${address.project}${kind === 'merge_request' ? '!' : '#'}${address.number}`
      try {
        await replyNote({ cli: clis.gitlab.cli, host: address.host ?? clis.gitlab.host, project: address.project,
          iid: Number(address.number), kind, body: message.text })
        log(`Posted a note on ${url}`)
        done(message)
      } catch (error) { log(`Could not post on ${url}: ${(error as Error).message}`) }
      continue
    }
    const address = message.channel.address as { repository?: string; number?: string }
    if (!address.number || !address.repository) continue
    if (!clis.github) { log(`Cannot post on ${address.repository}#${address.number}: the GitHub Source is off`); continue }
    try {
      await run(clis.github, ['api', `repos/${address.repository}/issues/${address.number}/comments`, '-f', `body=${message.text}`])
      log(`Posted a message on ${address.repository}#${address.number}`)
      done(message)
    } catch (error) { log(`Could not post on ${address.repository}#${address.number}: ${(error as Error).message}`) }
  }
}

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Engine, type Executor, type Outbox, type OutboundMessage, type Ticket, type Trigger, type Assignment, latestReport, runningAssignment } from './core/index.ts'
import { runnerFor, type AgentName, type AgentReport, type AgentRunner } from './agents/index.ts'
import { writeEnvironment, runEnvironment, type EnvironmentAccounts } from './infra/environment.ts'
import { run } from './infra/commands.ts'
import type { FileRepositories } from './state/files.ts'
import type { Settings } from './settings.ts'
import { composePrompt, standingRules } from './prompts.ts'
import { buildPolicy, sourceScope } from './policy.ts'
import { isQuietHours, isUserPresent } from './infra/presence.ts'
import { BudgetGuard, type BudgetState } from './infra/budget.ts'
import { TimerStore } from './infra/timers.ts'
import { WatcherEngine } from './infra/watchers.ts'
import { claudeAssessor } from './assess.ts'
import { assessing, type Decided } from './assessing.ts'
import { agentLogin, pollNotifications, pollOpenPullRequests } from './sources/github.ts'
import { closeIssue, closeMergeRequest, getIssue, gitlabLogin, issueTrigger, listOpenIssues, mergeMergeRequest, pollOpenMergeRequests, pollTodos, replyNote } from './sources/gitlab.ts'
import { botIdentity, chatMembers, consumeEvents, feishuTrigger, recentMessages, reply, sendMessage, type StreamHandle } from './sources/feishu.ts'
import { MemoryStore, WorkflowStore, memoryCommand, nextIssue, runChecks, workflowCommand, type Command } from './workflow.ts'
import { replyTweet, searchTweets, twitterAccount } from './sources/twitter.ts'
import { prepareWorktree, ticketBranch } from './infra/worktree.ts'
import { runPrVerification } from './infra/pr-verifier.ts'

/** Where the loop keeps its own bookkeeping, beside the domain state. */
const pollKey = 'github:poll'
const seenKey = (id: string) => `github:seen:${id}`

/** Lines one round reads from the stream at most, so a chat that keeps talking does not hold a round open. */
const MAX_LINES = 500

/**
 * The outbox of one run, plus the ids earlier runs already posted.
 *
 * A message goes out once, and a process that started later must know it: the id is deterministic
 * (`key('reply', triggerId, text)`), but the map alone forgets it at exit, so `poll --once` from cron re-posted every
 * ready report. The id of a posted message is kept in the state directory for the same reason the ticket is.
 */
function outbox(repo: FileRepositories): Outbox & { drain: () => OutboundMessage[]; sent: (id: string) => boolean } {
  const messages = new Map<string, OutboundMessage>()
  const sentKey = (id: string) => `outbox:${id}`
  const sent = (id: string): boolean => repo.getMeta<boolean>(sentKey(id)) === true
  return {
    send: message => { if (!messages.has(message.id) && !sent(message.id)) messages.set(message.id, message) },
    status: id => messages.has(id) ? 'pending' : sent(id) ? 'sent' : undefined,
    withdraw: id => { messages.delete(id) },
    /** A caller posts what is waiting; the message stays until the post succeeds, so a failed one is retried next round. */
    drain: () => [...messages.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sent,
  }
}

/**
 * Runs a ticket on the configured agent.
 *
 * The Engine calls `start` and expects a report through its own callbacks; this keeps the work asynchronous, so the loop
 * never blocks on an agent turn.
 */
class AgentExecutor implements Executor {
  private readonly active = new Map<string, AbortController>()
  /** Tickets whose turn waits for a free slot, oldest first. */
  private readonly pending: { ticket: Ticket; assignment: Assignment }[] = []
  /** Workflow tickets whose turn waits for the operator's yes. */
  private readonly held = new Map<string, { ticket: Ticket; assignment: Assignment }>()
  /** The questions being sent, which a finishing run waits for so a DM is not cut off by its own exit. */
  private readonly asks = new Set<Promise<void>>()
  private pumping = false
  constructor(private readonly options: {
    settings: Settings
    runner: AgentRunner
    stateDir: string
    repository: string
    agent: string
    accounts: EnvironmentAccounts
    engine: Engine
    /** How many tickets may run at once; the others wait in `pending` and start as a turn ends. */
    maxWorkers: number
    site: { started(ticketId: string, assignmentId: string): void; reported(ticketId: string, report: { state: string; summary: string; question?: string | null }): void
      failed(ticketId: string, assignmentId: string, summary: string): void; interrupted(ticketId: string, assignmentId: string): void }
    /** A held turn for one ticket, waiting for the operator's yes. */
    workflow?: {
      ask: (ticket: Ticket, trigger: Trigger) => Promise<void>
      done: (ticket: Ticket, trigger: Trigger, summary: string) => Promise<void>
    }
    prompt: (ticket: Ticket, directory: string, branch?: string, prVerification?: { passed: boolean; markdown: string }) => Promise<string>
    repo?: FileRepositories
    log?: (line: string) => void
  }) {}

  start(ticket: Ticket, assignment: Assignment): void {
    // The ticket is marked running now, so a round records the start before any turn of it exists; the turn itself waits
    // for a free slot, so a burst of accepted messages does not start more agents than the operator allows.
    this.options.site.started(ticket.id, assignment.id)
    this.dispatch(ticket, assignment)
  }

  /** Holds a workflow ticket for the operator's yes, or queues the turn in the free slots. */
  private dispatch(ticket: Ticket, assignment: Assignment): void {
    const trigger = this.options.repo?.triggers.get(ticket.origin.triggerId)
    if (this.options.workflow && trigger?.meta?.workflow === true) {
      this.held.set(ticket.id, { ticket, assignment })
      const ask = this.options.workflow.ask(ticket, trigger)
        .catch(error => this.options.log?.(`Could not ask about ${ticket.id}: ${(error as Error).message}`))
      this.asks.add(ask)
      void ask.finally(() => { this.asks.delete(ask) })
      return
    }
    this.pending.push({ ticket, assignment })
    this.pump()
  }

  /** Starts the held turn of a ticket the operator approved; false when this executor holds none. */
  release(ticketId: string): boolean {
    const held = this.held.get(ticketId)
    if (!held) return false
    this.held.delete(ticketId)
    this.pending.push(held)
    this.pump()
    return true
  }

  /** Drops a held turn, such as one the operator declined. */
  forget(ticketId: string): void { this.held.delete(ticketId) }

  deliver(): void {
    // A ticket runs one turn at a time; a message that arrives mid-turn is read at the next start.
  }

  /**
   * Takes in the tickets a previous process left running. Their agents ended with that process, so a turn that had not
   * reported is restarted with a recovery note, and one whose report a person still has to act on goes back to the queue
   * with its inputs. A start from `interrupted` joins the same queue as a new ticket.
   */
  recover(open: readonly Ticket[]): void {
    for (const ticket of open) {
      const assignment = runningAssignment(ticket)
      if (assignment) this.options.site.interrupted(ticket.id, assignment.id)
    }
    for (const ticket of open) {
      for (const assignment of ticket.assignments) if (assignment.state === 'pending') this.dispatch(ticket, assignment)
    }
    this.pump()
  }

  /** The Engine's memory of the ticket, so the report lands on a ticket that already holds this round's changes to it. */
  refresh(ticket: Ticket): void { this.options.engine.updateTicket(ticket) }

  stop(ticket: Ticket): void {
    this.active.get(ticket.id)?.abort()
    this.active.delete(ticket.id)
    this.held.delete(ticket.id)
    const waiting = this.pending.findIndex(item => item.ticket.id === ticket.id)
    if (waiting >= 0) this.pending.splice(waiting, 1)
    this.pump()
  }

  /** Starts waiting tickets while a slot is free; the turns run beside the rounds, so this never blocks on one. */
  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    // Each turn begins on a later tick: `start` and `report` run inside an Engine transaction, and a turn that read the
    // ticket there would miss what the transaction writes at its end.
    void Promise.resolve().then(() => {
      this.pumping = false
      // The reservation is taken before the turn begins, so the next `pump` sees the slot as used.
      while (this.active.size < this.options.maxWorkers && this.pending.length) {
        const item = this.pending.shift()!
        const controller = new AbortController()
        this.active.set(item.ticket.id, controller)
        void this.execute(item.ticket, item.assignment, controller)
      }
    })
  }

  /** Resolves when no turn runs, none waits for a slot, and every question has gone out. */
  idle(): Promise<void> {
    if (!this.active.size && !this.pending.length && !this.asks.size) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setInterval(() => {
        if (this.active.size || this.pending.length || this.asks.size) return
        clearInterval(timer)
        resolve()
      }, 50)
    })
  }

  private async execute(ticket: Ticket, assignment: Assignment, controller: AbortController): Promise<void> {
    const { settings, runner, stateDir, accounts, site, repo, log } = this.options
    // A shared installation works on the checkout's own branch, which is the long-lived development branch: no worktree,
    // no per-ticket branch, and one issue at a time.
    const shared = settings.executor.worktree === false
    const directory = shared ? settings.checkout : ticket.execution?.directory ?? join(stateDir, 'work', ticket.id)
    const trigger = repo?.triggers.get(ticket.origin.triggerId)
    const isPrReview = Boolean(trigger?.meta?.isPr) || ticket.mandate.scope === 'pr_review'
    const prNumber = typeof trigger?.meta?.number === 'number' ? trigger.meta.number : undefined
    const source = trigger?.source === 'gitlab' ? 'gitlab' as const : 'github' as const
    // The review settings of the forge this ticket came from; a GitLab merge request uses `mrReview`, a GitHub PR `prReview`.
    const review = source === 'gitlab' ? settings.gitlab?.mrReview : settings.github?.prReview

    try {
      // Each ticket gets its own branch off the checkout's HEAD, or checks out the review's head.
      const branch = shared ? undefined : ticketBranch(settings.branchPrefix, ticket.title, ticket.id)
      if (!shared && branch) {
        await prepareWorktree({
          checkout: settings.checkout,
          directory,
          branch,
          prNumber: isPrReview ? prNumber : undefined,
          repository: source === 'gitlab' ? settings.gitlab?.project : settings.github?.repository,
          ...source === 'gitlab' && settings.gitlab && prNumber !== undefined
            ? { ref: `refs/merge-requests/${prNumber}/head`, remote: `https://${settings.gitlab.host}/${settings.gitlab.project}.git` }
            : {},
          signal: controller.signal,
        })
      }

      if (settings.executor.prepare) await run('/bin/sh', ['-c', settings.executor.prepare], { env: this.variables(ticket, directory, branch), timeoutMs: 120_000 })

      // Execute automated local verification commands inside the checked-out review worktree
      let prVerification: { passed: boolean; markdown: string } | undefined
      if (isPrReview && review?.verifyCommands?.length) {
        prVerification = await runPrVerification({
          cwd: directory,
          commands: review.verifyCommands,
          timeoutSeconds: review.verifyTimeoutSeconds,
          signal: controller.signal,
        })
      }

      const prompt = await this.options.prompt(ticket, directory, branch, prVerification)
      const isAutonomous = ticket.mandate.strength === 'inferred' && !isPrReview
      const result = await runner.run({
        prompt,
        cwd: directory,
        env: runEnvironment(accounts, this.variables(ticket, directory, branch)),
        signal: controller.signal,
        timeoutMs: settings.executor.timeoutMinutes * 60_000,
        model: settings.executor.model,
        readOnly: isAutonomous,
      })
      const report = result.report ?? inferReport(result.finalText, result.ok)

      // Handle review actions: merge or close the request the ticket was asked to review.
      if (isPrReview && prNumber && review) {
        const textToAnalyze = `${result.finalText}\n${report.summary}`
        const decisionMatch = /DECISION:\s*(MERGE|APPROVE|REQUEST_CHANGES|CLOSE)/i.exec(textToAnalyze)
        const decision = decisionMatch ? decisionMatch[1]!.toUpperCase() : (report.state === 'ready' ? 'APPROVE' : 'REQUEST_CHANGES')
        const request = source === 'gitlab' ? `MR !${prNumber}` : `PR #${prNumber}`
        const project = source === 'gitlab' ? settings.gitlab?.project : settings.github?.repository
        const verdict = (state: string): string => `🤖 **SuperAgent Review Verdict: ${state}**\n\n${deliverable(report.summary)}`

        if (decision === 'MERGE' && review.autoMerge && (!prVerification || prVerification.passed)) {
          try {
            if (source === 'gitlab' && settings.gitlab) {
              const gitlab = settings.gitlab
              await mergeMergeRequest({ cli: gitlab.cli, host: gitlab.host, project: gitlab.project, iid: prNumber,
                squash: gitlab.mrReview?.squash ?? true, autoMerge: true })
              await replyNote({ cli: gitlab.cli, host: gitlab.host, project: gitlab.project, iid: prNumber, kind: 'merge_request',
                body: `${verdict('MERGED')}\n\nAutomated local verification passed and code review approved.` }).catch(() => {})
            } else if (settings.github) {
              const github = settings.github
              const method = github.prReview?.mergeMethod ?? 'squash'
              await run(github.cli, ['pr', 'merge', String(prNumber), `--${method}`, '--auto', '--repo', github.repository])
              await run(github.cli, ['pr', 'comment', String(prNumber), '--repo', github.repository, '-b',
                `${verdict('MERGED')}\n\nAutomated local verification passed and code review approved.`]).catch(() => {})
            }
            log?.(`Merged ${request} on ${project}`)
          } catch (mergeErr: any) {
            log?.(`Could not merge ${request}: ${mergeErr.message}`)
          }
        } else if (decision === 'CLOSE') {
          try {
            if (source === 'gitlab' && settings.gitlab) {
              const gitlab = settings.gitlab
              await closeMergeRequest({ cli: gitlab.cli, host: gitlab.host, project: gitlab.project, iid: prNumber })
              await replyNote({ cli: gitlab.cli, host: gitlab.host, project: gitlab.project, iid: prNumber, kind: 'merge_request',
                body: verdict('CLOSED') }).catch(() => {})
            } else if (settings.github) {
              const github = settings.github
              await run(github.cli, ['pr', 'close', String(prNumber), '--repo', github.repository, '-c', verdict('CLOSED')])
            }
            log?.(`Closed ${request} on ${project}`)
          } catch (closeErr: any) {
            log?.(`Could not close ${request}: ${closeErr.message}`)
          }
        }
      }

      if (report.followupAfterSeconds && report.followupAfterSeconds > 0) {
        const timerStore = new TimerStore(stateDir)
        await timerStore.save({
          id: `followup-${ticket.id}-${Date.now()}`,
          kind: 'followup',
          ticketId: ticket.id,
          dueAt: new Date(Date.now() + report.followupAfterSeconds * 1000).toISOString(),
          prompt: `Follow-up checkpoint for ticket ${ticket.id}: ${report.summary}`,
          createdAt: new Date().toISOString(),
        })
      }
      await appendLog(directory, prompt, result.raw.slice(-20_000), report)
      site.reported(ticket.id, { state: report.state ?? (result.ok ? 'ready' : 'failed'), summary: report.summary, question: report.question ?? null })
      // The workflow's summary and close question follow the report; a Feishu outage is a log line, not a lost turn.
      const workflowTrigger = repo?.triggers.get(ticket.origin.triggerId)
      if (this.options.workflow && workflowTrigger?.meta?.workflow === true) {
        await this.options.workflow.done(ticket, workflowTrigger, report.summary)
          .catch(error => log?.(`Could not report on ${ticket.id}: ${(error as Error).message}`))
      }
    } catch (error) {
      site.failed(ticket.id, assignment.id, `The agent could not run: ${(error as Error).message}`)
    } finally {
      this.active.delete(ticket.id)
      // The free slot goes to the next waiting ticket; a report that arrived with the turn is finished and must not start it.
      this.pump()
    }
  }

  private variables(ticket: Ticket, directory: string, branch?: string): Record<string, string> {
    const trigger = ticket.origin
    return {
      SUPERAGENT_TICKET: ticket.id,
      SUPERAGENT_DIR: directory,
      SUPERAGENT_BRANCH: branch ?? '',
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
  const entry = ['', `## ${new Date().toISOString()}`, '', '**Prompt**', '', '```', prompt, '```', '', '**Report**', '', '```json', JSON.stringify(report, null, 2), '```',
    '', '**Agent output**', '', '```', raw, '```'].join('\n')
  // `appendFile` rather than a read and a rewrite: a stream can end several turns of one ticket at once, and each turn must
  // keep its entry.
  await mkdir(join(directory, '.superagent'), { recursive: true }).then(() => appendFile(path, `${entry}\n`))
}

export interface LoopOptions {
  settings: Settings
  repo: FileRepositories
  signal: AbortSignal
  log: (line: string) => void
  /** Run one round and return, instead of waiting for the poll interval. */
  once?: boolean
  /** With `once`, wait for the turns the round started and post what they reported: a process that exits first kills a
   * long agent, and the next run restarts it. */
  finish?: boolean
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
  const gitlab = settings.gitlab?.enabled ? settings.gitlab : undefined
  const feishu = settings.feishu?.enabled ? settings.feishu : undefined
  const twitter = settings.twitter?.enabled ? settings.twitter : undefined
  const workflow = settings.workflow?.enabled ? settings.workflow : undefined
  if (workflow && (!gitlab || !feishu)) throw new Error('The issue workflow asks in Feishu about GitLab issues; turn both Sources on.')
  // A workflow answers are read from its direct chat each round, because an app allows one event connection and another
  // host may hold it; with no group chat configured, the event stream has nothing else to read.
  const listen = Boolean(feishu) && !(workflow && (feishu!.chats?.length ?? 0) === 0)
  const workflowStore = workflow ? new WorkflowStore(settings.stateDir) : undefined
  if (workflowStore) await workflowStore.init()
  const memory = workflow ? new MemoryStore(settings.stateDir) : undefined
  if (!github && !gitlab && !feishu && !twitter) throw new Error('No Source is on in settings.yaml; nothing to poll.')
  const login = github ? await agentLogin(github.cli, signal) : gitlab ? await gitlabLogin(gitlab.cli, gitlab.host, signal) : ''
  const twitterBot = twitter ? await twitterAccount(twitter.cli, signal) : ''
  // The shim of a Source this installation does not have points at nothing usable; its CLI then fails inside the run,
  // which is right. A worker never falls back to the operator's own credentials.
  const accounts: EnvironmentAccounts = {
    stateDir: settings.stateDir,
    ...github ? { githubCli: github.cli } : {},
    ...gitlab ? { gitlabCli: gitlab.cli, gitlabHost: gitlab.host } : {},
    ...feishu ? { feishuCli: feishu.cli } : {},
    agentLogin: login,
  }
  /** The project the tickets change, in the forge's own naming. */
  const repository = github?.repository ?? gitlab?.project ?? settings.checkout
  await writeEnvironment(accounts, settings.executor.blockedCommands)
  const standing = await standingRules()

  const channel = outbox(repo)
  const destinations = {
    ...github ? { github: github.cli } : {},
    ...gitlab ? { gitlab: { cli: gitlab.cli, host: gitlab.host } } : {},
    ...feishu ? { feishu: feishu.cli } : {},
    ...twitter ? { twitter: twitter.cli } : {},
  }
  const markSent = (id: string): void => { repo.setMeta(`outbox:${id}`, true) }
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
    failed: (ticketId: string, _assignmentId: string, summary: string) => {
      record(engine, repo, [{ ticketId, report: { state: 'failed', summary } }], log)
    },
    interrupted: (ticketId: string, assignmentId: string) => {
      try { engine.assignmentInterrupted(ticketId, assignmentId) } catch (error) { log(`Could not recover ${ticketId}: ${(error as Error).message}`) }
    },
  }
  // A workflow ticket is held until the operator says yes in Feishu; the ask and the summary are direct messages.
  let executor!: AgentExecutor
  const askAbout = async (ticket: Ticket, trigger: Trigger): Promise<void> => {
    const iid = Number(trigger.meta.number)
    const record = await workflowStore!.get(iid)
    // An answer that arrived before a restart already approved this ticket; start it instead of asking again.
    if (record?.phase === 'working') { executor.release(ticket.id); return }
    await workflowStore!.save({ iid, ticketId: ticket.id, phase: 'waiting', at: new Date().toISOString() })
    const title = trigger.text.split('\n')[0]!.trim()
    if (!feishu || !workflow) return
    const sent = await sendMessage(feishu.cli, { userId: workflow.user },
      `**#${iid} ${title}**\n\n${trigger.url ?? ''}\n\n要做吗？回复 \`做 #${iid}\` 或 \`不做 #${iid}\`。`, `ask-${iid}`, signal)
    // The direct chat's id is where the answer is read from, when the event stream is held by another host.
    if (sent.chatId) repo.setMeta('workflow:dm', sent.chatId)
  }
  const doneAbout = async (ticket: Ticket, trigger: Trigger, summary: string): Promise<void> => {
    if (!workflow || !feishu || !workflowStore) return
    const iid = Number(trigger.meta.number)
    const directory = ticket.execution?.directory ?? join(settings.stateDir, 'work', ticket.id)
    const checks = workflow.verifyCommands.length ? await runChecks(workflow.verifyCommands, directory, signal) : ''
    await workflowStore.save({ iid, ticketId: ticket.id, phase: 'closing', at: new Date().toISOString() })
    const title = trigger.text.split('\n')[0]!.trim()
    await sendMessage(feishu.cli, { userId: workflow.user },
      `**完成 #${iid}** ${title}\n\n${summary}\n\n${checks ? `**验证**\n${checks}\n\n` : ''}关闭吗？回复 \`关闭 #${iid}\` 或 \`保留 #${iid}\`。`, `summary-${iid}`, signal)
  }
  executor = new AgentExecutor({
    engine, settings, maxWorkers: settings.executor.maxWorkers, runner: runnerFor(settings.executor.agent as AgentName, settings.executor.binary), stateDir: settings.stateDir,
    repository, agent: login, accounts,
    site,
    repo,
    log,
    ...workflow ? { workflow: { ask: askAbout, done: doneAbout } } : {},
    prompt: async (ticket, directory, branch, prVerification) => {
      const trigger = repo.triggers.get(ticket.origin.triggerId)
      const source = trigger?.source === 'feishu' ? 'feishu' as const : trigger?.source === 'gitlab' ? 'gitlab' as const : 'github' as const
      const isPrReview = Boolean(trigger?.meta?.isPr) || ticket.mandate.scope === 'pr_review'
      const prNumber = typeof trigger?.meta?.number === 'number' ? trigger.meta.number : undefined
      // A text input is a note the Engine carries, such as a recovery note after a restart; a fresh turn has not read it.
      const notes = ticket.inputs.flatMap(input => input.kind === 'text' ? [input.text] : [])
      const readOnly = ticket.mandate.strength === 'inferred' && !isPrReview
      const autoMerge = source === 'gitlab' ? gitlab?.mrReview?.autoMerge : github?.prReview?.autoMerge
      return composePrompt({
        ticket, trigger, repository, agentLogin: login, branchPrefix: settings.branchPrefix,
        source, instructions: settings.prompts, branch, standing, notes, readOnly,
        isPrReview, prNumber, prVerification, autoMergeAllowed: Boolean(autoMerge), mergeInto: workflow?.mergeInto,
        shared: settings.executor.worktree === false, memory: memory ? await memory.rules() : [], reflect: Boolean(workflow),
      })
    },
  })
  /** Adds a rule the operator wrote, and says how full the list is. */
  const rememberRule = async (command: { iid: number; text: string }): Promise<void> => {
    if (!memory || !workflow || !feishu) return
    const rules = await memory.remember(command.text, workflow.memoryLines)
    await sendMessage(feishu.cli, { userId: workflow.user },
      `记住了（${rules.length}/${workflow.memoryLines} 条）：${command.text}`, `memory-${command.iid}-${Date.now()}`, signal)
      .catch(error => log(`Could not confirm the rule: ${(error as Error).message}`))
  }
  /** Sends the rules back every `reviewDays` so a person can delete what is wrong. */
  const reviewMemory = async (): Promise<void> => {
    if (!memory || !workflow || !feishu) return
    if (!await memory.dueForReview(workflow.reviewDays)) return
    const rules = await memory.rules()
    if (rules.length) {
      await sendMessage(feishu.cli, { userId: workflow.user },
        `**规则回顾（${workflow.reviewDays} 天一次）**\n\n${rules.join('\n')}\n\n读一遍，过时的直接编辑 \`${memory.file()}\` 删掉。`,
        `memory-review-${new Date().toISOString().slice(0, 10)}`, signal)
        .catch(error => log(`Could not send the memory review: ${(error as Error).message}`))
    }
    await memory.markReviewed()
  }
  /** The operator's answer in Feishu: start, skip, close or keep the issue the workflow is on. */
  const handleWorkflowCommand = async (command: Command): Promise<void> => {
    if (!workflow || !feishu || !workflowStore || !gitlab) return
    const record = await workflowStore.get(command.iid)
    const say = (text: string, key: string): Promise<void> => sendMessage(feishu.cli, { userId: workflow.user }, text, key, signal)
      .then(() => undefined)
      .catch(error => { log(`Could not answer #${command.iid}: ${(error as Error).message}`) })
    if (!record) { await say(`没有在等 #${command.iid} 的决定。`, `noop-${command.iid}-${Date.now()}`); return }
    if (command.verb === 'do' && record.phase === 'waiting') {
      await workflowStore.save({ ...record, phase: 'working', at: new Date().toISOString() })
      if (!record.ticketId || !executor.release(record.ticketId)) log(`#${command.iid}: no held turn to start; the next round restarts it`)
      return
    }
    if (command.verb === 'skip' && (record.phase === 'waiting' || record.phase === 'working')) {
      await workflowStore.save({ ...record, phase: 'skipped', at: new Date().toISOString() })
      if (record.ticketId) {
        executor.forget(record.ticketId)
        try { engine.stopTicket(record.ticketId, 'declined') } catch { /* the ticket already ended */ }
      }
      await say(`已跳过 #${command.iid}。`, `skip-${command.iid}`)
      return
    }
    if (command.verb === 'close' && record.phase === 'closing') {
      try {
        await closeIssue({ cli: gitlab.cli, host: gitlab.host, project: gitlab.project, iid: command.iid, signal })
        await workflowStore.save({ ...record, phase: 'done', at: new Date().toISOString() })
        await say(`已关闭 #${command.iid}。`, `close-${command.iid}`)
      } catch (error) {
        await say(`关闭 #${command.iid} 失败：${(error as Error).message}`, `close-failed-${command.iid}-${Date.now()}`)
      }
      return
    }
    if (command.verb === 'keep' && record.phase === 'closing') {
      await workflowStore.save({ ...record, phase: 'done', at: new Date().toISOString() })
      await say(`保留 #${command.iid}。`, `keep-${command.iid}`)
      return
    }
    await say(`#${command.iid} 现在不接受这个决定。`, `state-${command.iid}-${Date.now()}`)
  }
  /**
   * Moves on from an issue GitLab now has closed, which a person may do outside the workflow: the local record is a
   * snapshot, and without this check a closed issue would sit at "waiting" and block the queue.
   */
  const reconcileWorkflow = async (): Promise<void> => {
    if (!workflow || !workflowStore || !gitlab) return
    for (const record of await workflowStore.all()) {
      if (record.phase !== 'waiting' && record.phase !== 'working' && record.phase !== 'closing') continue
      try {
        const issue = await getIssue({ cli: gitlab.cli, host: gitlab.host, project: gitlab.project, iid: record.iid, signal })
        if (issue.state !== 'closed') continue
        await workflowStore.save({ ...record, phase: 'done', at: new Date().toISOString() })
        if (record.ticketId) {
          executor.forget(record.ticketId)
          try { engine.stopTicket(record.ticketId, 'issueClosed') } catch { /* the ticket already ended */ }
        }
        log(`#${record.iid} is closed on GitLab; the workflow moves on`)
        if (feishu && workflow.user) {
          await sendMessage(feishu.cli, { userId: workflow.user }, `#${record.iid} 在 GitLab 上已关闭，跳过。`,
            `closed-${record.iid}-${new Date().toISOString().slice(0, 10)}`, signal)
            .catch(error => log(`Could not say #${record.iid} was closed: ${(error as Error).message}`))
        }
      } catch (error) { if (!signal.aborted) log(`Could not read #${record.iid}: ${(error as Error).message}`) }
    }
  }
  /** Proposes the next labeled issue when nothing waits for a yes, a turn, or a close. */
  const proposeIssue = async (): Promise<void> => {
    if (!workflow || !workflowStore || !gitlab) return
    if (await workflowStore.active()) return
    try {
      const issues = await listOpenIssues({ cli: gitlab.cli, host: gitlab.host, project: gitlab.project, label: workflow.label, signal })
      const seen = new Set((await workflowStore.all()).map(record => record.iid))
      const next = nextIssue(issues, seen)
      if (!next) return
      await workflowStore.save({ iid: next.iid, phase: 'waiting', at: new Date().toISOString() })
      const result = engine.receive(issueTrigger({ issue: next, host: gitlab.host, project: gitlab.project }))
      if (result !== 'duplicate') log(`Proposed issue #${next.iid}: ${next.title}`)
    } catch (error) { if (!signal.aborted) log(`Could not read the issue queue: ${(error as Error).message}`) }
  }
  /**
   * Reads the operator's direct chat for answers, which is the stream's fallback: an app allows one event connection, and
   * another host holding it would leave this installation deaf. The chat id is the one the last question went to.
   */
  const pollWorkflowDm = async (): Promise<void> => {
    if (!workflow || !feishu) return
    const chatId = repo.getMeta<string>('workflow:dm')
    if (!chatId) return
    const seen = new Set(repo.getMeta<string[]>('workflow:dmSeen') ?? [])
    try {
      const messages = await recentMessages(feishu.cli, chatId, signal)
      for (const message of [...messages].reverse()) {
        if (seen.has(message.messageId)) continue
        seen.add(message.messageId)
        if (message.senderId !== workflow.user) continue
        const remembered = memoryCommand(message.text)
        if (remembered) { await rememberRule(remembered); continue }
        const command = workflowCommand(message.text)
        if (command) await handleWorkflowCommand(command)
      }
      repo.setMeta('workflow:dmSeen', [...seen].slice(-300))
    } catch (error) { if (!signal.aborted) log(`Could not read the workflow DM: ${(error as Error).message}`) }
  }
  /** Commands being handled, which a finishing run waits for so their answer is not cut off by its own exit. */
  const commands = new Set<Promise<unknown>>()
  const track = (work: Promise<unknown>): void => {
    const tracked = work.catch(() => undefined)
    commands.add(tracked)
    void tracked.finally(() => { commands.delete(tracked) })
  }
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
      .then(trigger => {
        if (!trigger) return
        // The operator's answer to a workflow question is a direct message from the configured user, not a new request.
        const mine = workflow && trigger.meta?.direct === true && trigger.actor.id === workflow.user
        const remembered = mine ? memoryCommand(trigger.text) : undefined
        if (remembered) { track(rememberRule(remembered)); return }
        const command = mine ? workflowCommand(trigger.text) : undefined
        if (command) { track(handleWorkflowCommand(command)); return }
        store(trigger)
      })
      .catch(error => { log(`Could not store an event: ${(error as Error).message}`) })
  }
  // A consumer runs for the whole round loop, not for one round: Feishu pushes a message to the stream, and a stream that
  // stops and starts between rounds drops what is sent while it is down. The rounds read what it stored between their steps.
  let handle: StreamHandle | undefined
  // A run in one process, such as a round on demand, starts its stream again while the process lives; one that ends with the
  // round also ends its stream, or the process that started it never exits.
  const stopListening = new AbortController()
  if (options.once) caller.addEventListener('abort', () => stopListening.abort(), { once: true })
  if (feishu && listen) {
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

  const timerStore = new TimerStore(settings.stateDir)
  const watcherEngine = new WatcherEngine(settings.stateDir)
  const budgetGuard = new BudgetGuard(settings.budget, {
    get: () => repo.getMeta<BudgetState>('budget:state'),
    set: s => repo.setMeta('budget:state', s),
  })

  // A ticket a previous process left running has no agent behind it: its turn ended with that process. Recovery reads the
  // disk, before a round takes the Engine's memory as the latest word, and starts the tickets again within the limit.
  try {
    for (const ticket of repo.tickets.active()) engine.updateTicket(ticket)
    executor.recover(repo.tickets.active())
  } catch (error) { log(`Could not recover the tickets left running: ${(error as Error).message}`) }
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
    if (!feishu || !listen) return
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
      if (feishu && listen) identify()
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

        if (github.prReview?.enabled && github.prReview?.pollOpenPrs !== false) {
          try {
            const prTriggers = await pollOpenPullRequests({
              cli: github.cli,
              repository: github.repository,
              agent: login,
              signal,
              seen: id => repo.getMeta<boolean>(id) === true,
              mark: id => repo.setMeta(id, true),
            })
            for (const trigger of prTriggers) {
              const result = engine.receive(trigger)
              if (result !== 'duplicate') log(`Received PR review trigger for #${trigger.meta?.number} from ${trigger.actor.id}`)
            }
          } catch (prErr: any) {
            if (!signal.aborted) log(`PR poll failed: ${prErr.message}`)
          }
        }

        since = round
        repo.setMeta(pollKey, since)
      }
      if (gitlab) {
        try {
          const triggers = await pollTodos({
            cli: gitlab.cli, host: gitlab.host, project: gitlab.project, agent: login, signal,
            seen: id => repo.getMeta<boolean>(seenKey(id)) === true,
            mark: id => repo.setMeta(seenKey(id), true),
          })
          for (const trigger of triggers) {
            const result = engine.receive(trigger)
            if (result !== 'duplicate') log(`Received ${trigger.id} from ${trigger.actor.id} on ${trigger.threads[0]!.id}`)
          }
        } catch (error) {
          if (!signal.aborted) log(`GitLab poll failed: ${(error as Error).message}`)
        }
        if (gitlab.mrReview?.enabled && gitlab.mrReview.pollOpenMrs !== false) {
          try {
            const triggers = await pollOpenMergeRequests({
              cli: gitlab.cli, host: gitlab.host, project: gitlab.project, agent: login, signal,
              seen: id => repo.getMeta<boolean>(`gitlab:seen:${id}`) === true,
              mark: id => repo.setMeta(`gitlab:seen:${id}`, true),
            })
            for (const trigger of triggers) {
              const result = engine.receive(trigger)
              if (result !== 'duplicate') log(`Received MR review trigger for !${trigger.meta?.number} from ${trigger.actor.id}`)
            }
          } catch (error) {
            if (!signal.aborted) log(`Merge request poll failed: ${(error as Error).message}`)
          }
        }
      }
      if (workflow) { await reconcileWorkflow(); await proposeIssue(); await pollWorkflowDm(); await reviewMemory() }
      if (twitter) {
        try {
          const triggers = await searchTweets(twitter.cli, twitter.query, {
            seen: id => repo.getMeta<boolean>(`twitter:seen:${id}`) === true,
            mark: id => repo.setMeta(`twitter:seen:${id}`, true),
            agentLogin: twitterBot,
            signal,
          })
          for (const trigger of triggers) {
            const result = engine.receive(trigger)
            if (result !== 'duplicate') log(`Received Twitter trigger ${trigger.id} from @${trigger.actor.id}`)
          }
        } catch (error) {
          if (!signal.aborted) log(`Twitter poll failed: ${(error as Error).message}`)
        }
      }
      // Process active watchers
      if (settings.watchers && settings.watchers.length > 0) {
        for (const watcher of settings.watchers) {
          try {
            const check = await watcherEngine.check(watcher, { now: new Date() })
            if (check.triggered && check.diffText) {
              const budgetCheck = await budgetGuard.check()
              if (!budgetCheck.allowed) {
                log(`Watcher ${watcher.id} triggered but postponed: ${budgetCheck.reason}`)
                continue
              }
              await budgetGuard.record()
              log(`Watcher ${watcher.id} detected output changes; generating trigger`)
              const trigger: Trigger = {
                id: `watcher:${watcher.id}:${Date.now()}`,
                source: 'watcher',
                threads: [{ source: 'watcher', id: watcher.id }],
                actor: { source: 'watcher', id: 'system' },
                human: false,
                at: new Date().toISOString(),
                text: check.diffText,
                meta: { watcherId: watcher.id },
              }
              const result = repo.atomic(() => engine.receive(trigger))
              if (result !== 'duplicate') log(`Received watcher trigger ${trigger.id}`)
            }
          } catch (error) {
            log(`Watcher ${watcher.id} check error: ${(error as Error).message}`)
          }
        }
      }
      // Process due timers
      if (settings.timers?.enabled) {
        const dueTimers = await timerStore.getDue(new Date())
        for (const timer of dueTimers) {
          const budgetCheck = await budgetGuard.check()
          if (!budgetCheck.allowed) {
            log(`Timer ${timer.id} postponed: ${budgetCheck.reason}`)
            break
          }
          await budgetGuard.record()
          log(`Firing due timer ${timer.id} (${timer.kind})`)
          const trigger: Trigger = {
            id: `timer:${timer.id}:${Date.now()}`,
            source: 'timer',
            threads: [{ source: 'timer', id: timer.ticketId ?? timer.id }],
            actor: { source: 'timer', id: 'system' },
            human: false,
            at: new Date().toISOString(),
            text: timer.prompt,
            meta: { timerId: timer.id, kind: timer.kind, ticketId: timer.ticketId },
          }
          const result = repo.atomic(() => engine.receive(trigger))
          if (result !== 'duplicate') log(`Received timer trigger ${trigger.id}`)
          await timerStore.processDue(timer, new Date())
        }
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
      await send(channel, destinations, log, settings.attention, markSent)
      await repo.flush()
      await sync()
    } catch (error) {
      if (!signal.aborted) log(`Round failed: ${(error as Error).message}\n${(error as Error).stack?.split('\n').slice(1, 4).join('\n')}`)
    }
    if (options.once) break
    // A turn that ends during the wait is recorded by the next round, which starts at once instead of at the interval;
    // a GitHub Source with a longer interval waits in the same way, and the Source's own timer adds nothing to it.
    const seconds = Math.min(github?.pollSeconds ?? Infinity, gitlab?.pollSeconds ?? Infinity, feishu ? 15 : Infinity, twitter?.pollSeconds ?? Infinity)
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
  // A one-round process finishes what it started: waiting for the turns keeps an agent that needs longer than a round
  // alive, and the extra delivery posts the report it wrote instead of leaving it to the next cron run.
  if (options.once && options.finish) {
    await executor.idle()
    await Promise.allSettled([...commands])
    deliver(engine, repo, delivered, log)
    await repo.flush()
    await send(channel, destinations, log, settings.attention, markSent)
    await repo.flush()
  }
  // The stream starts with the first round, and a stream that ended starts again with the next one, so it lives past a round
  // on demand: a consumer the last round stops loses what Feishu pushes until another round starts. It ends with the whole
  // run, in its own time so the process that started it can exit after its last round.
  stop.abort()
  // A process that ran one round leaves nothing behind: a consumer or the agent's shim a round started holds the event
  // loop open until it ends, and one whose removal needs an event-loop turn ends on the next one, from the top-level check.
  // A test embeds this loop in its own process and ends it when the test ends, so it leaves the exit to the caller.
  if (options.once && !process.env.VITEST) setImmediate(() => process.exit(process.exitCode ?? 0))
}
