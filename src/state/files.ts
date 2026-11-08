/**
 * File-backed durable state.
 *
 * Every aggregate is one JSON file under the state directory. The layout is meant to be read by a person or an agent with
 * `ls` and `cat`, so no index is required to answer "what is open" or "what happened": the directory names carry the answer.
 *
 * ```
 * state/
 *   triggers/<thread>/<at>-<id>.json
 *   threads/<threadKey>.json
 *   tickets/<id>/ticket.json
 *   tickets/<id>/log.md
 *   decisions/<id>.json
 *   outbox/<id>.json
 *   meta/<key>.json
 * ```
 *
 * Writes go through a temporary file and a rename, so a reader never sees half a file. `atomic` serialises writers in
 * process and buffers file writes until the outermost transaction commits, so a failed unit of work leaves no trace.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { threadKey, type Decision, type Repositories, type Thread, type Ticket, type Trigger, type TriggerDisposition } from '../core/index.ts'

const encode = (value: string): string => Buffer.from(value).toString('base64url')
const decode = (value: string): string => Buffer.from(value, 'base64url').toString()

/** A pending file operation applied when the outermost transaction commits. */
type Op = { path: string; value: string | undefined }

export class FileRepositories implements Repositories {
  private readonly pending: Op[] = []
  private depth = 0
  private queue: Promise<unknown> = Promise.resolve()
  /** Every file that exists now, refreshed by `refresh`; lookups read only what this lists, so scans stay cheap. */
  private disk = new Map<string, unknown>()

  constructor(readonly stateDir: string) {}

  /** Creates the directories and loads every stored file into memory. Call once before use. */
  async open(): Promise<void> {
    for (const dir of ['triggers', 'threads', 'tickets', 'decisions', 'outbox', 'meta']) await mkdir(join(this.stateDir, dir), { recursive: true })
    await this.refresh()
  }

  private async refresh(): Promise<void> {
    const read = async (dir: string): Promise<string[]> => {
      try { return await readdir(join(this.stateDir, dir)) } catch { return [] }
    }
    const all = new Map<string, unknown>()
    const load = async (path: string): Promise<unknown | undefined> => {
      try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined }
    }
    for (const name of await read('threads')) {
      const value = await load(join(this.stateDir, 'threads', name))
      if (value) all.set(`thread:${decode(name.replace(/\.json$/, ''))}`, value)
    }
    for (const name of await read('decisions')) {
      const value = await load(join(this.stateDir, 'decisions', name))
      if (value) all.set(`decision:${name.replace(/\.json$/, '')}`, value)
    }
    for (const name of await read('outbox')) {
      const value = await load(join(this.stateDir, 'outbox', name))
      if (value) all.set(`outbox:${name.replace(/\.json$/, '')}`, value)
    }
    for (const name of await read('meta')) {
      const value = await load(join(this.stateDir, 'meta', name))
      if (value) all.set(`meta:${decode(name.replace(/\.json$/, ''))}`, value)
    }
    for (const name of await read('tickets')) {
      const value = await load(join(this.stateDir, 'tickets', name, 'ticket.json'))
      if (value) all.set(`ticket:${name}`, value)
    }
    for (const name of await read('triggers')) {
      for (const file of await read(join('triggers', name))) {
        const value = await load(join(this.stateDir, 'triggers', name, file))
        if (value) all.set(`trigger:${decode(name)}:${file.replace(/\.json$/, '')}`, value)
      }
    }
    this.disk = all
  }

  /**
   * Writes every change and re-reads every file, so a reader in this process sees what other writers stored and other
   * processes see what this one did. A long-running poller calls this between rounds.
   */
  async reload(): Promise<void> {
    await this.flush()
    await this.refresh()
  }

  // Paths

  private pathOf(op: Op): string { return join(this.stateDir, op.path) }

  private triggerDir(thread: string): string { return join('triggers', encode(thread)) }

  /** Writes and deletes buffered until the outermost transaction commits. */
  private write(path: string, value: unknown): void {
    const op = { path, value: JSON.stringify(value, null, 2) }
    this.pending.push(op)
    // Reads later in the same transaction see the write, before it reaches disk.
    this.apply(op)
  }

  private remove(path: string): void {
    const op: Op = { path, value: undefined }
    this.pending.push(op)
    this.apply(op)
  }

  /** Applies a pending operation to the in-memory view so reads inside the same transaction see it. */
  private apply(op: Op): void {
    const logical = this.logicalKey(op)
    if (op.value === undefined) { this.disk.delete(logical); return }
    this.disk.set(logical, JSON.parse(op.value))
  }

  /**
   * The in-memory name a file path maps to, matching the names `refresh` builds. Files at the top of a directory are named
   * after their key alone, so their name is the encoded key; a trigger sits one directory deeper, under a thread.
   */
  private logicalKey(op: Op): string {
    const [kind, ...rest] = op.path.split('/')
    const name = rest.join('/').replace(/\.json$/, '')
    if (kind === 'tickets') return `ticket:${rest[0]}`
    if (kind === 'threads') return `thread:${decode(basename(name))}`
    if (kind === 'decisions') return `decision:${decode(name)}`
    if (kind === 'outbox') return `outbox:${decode(name)}`
    if (kind === 'meta') return `meta:${decode(name)}`
    return `trigger:${decode(rest[0]!)}:${rest.slice(1).join('/').replace(/\.json$/, '')}`
  }

  private async commit(ops: Op[]): Promise<void> {
    for (const op of ops) {
      const path = this.pathOf(op)
      if (op.value === undefined) { await rm(path, { force: true }); continue }
      await mkdir(join(path, '..'), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, op.value, 'utf8')
      await rename(temporary, path)
    }
  }

  /**
   * Runs `work` as one unit: its writes and deletes become visible in memory at once and reach disk only when the outermost
   * call commits. A thrown error discards them.
   */
  atomic<T>(work: () => T): T {
    // The domain calls this synchronously while the durable layer is asynchronous, so the commit is serialised on a queue.
    const level = this.depth++
    const outer = level === 0
    const before = this.pending.length
    // Writes show in memory at once, so a failed unit of work must restore what it changed.
    const undo = outer ? new Map([...this.disk].map(([name, value]) => [name, value])) : undefined
    try {
      const value = work()
      if (outer) {
        const ops = this.pending.splice(0)
        this.depth = 0
        const previous = this.queue
        // A reload that read the files before this commit would otherwise leave a reader without what the commit wrote.
        this.queue = previous.then(() => this.commit(ops)).then(() => {
          if (previous !== this.queue) return
          for (const op of ops) this.apply(op)
        }).catch(() => {})
      } else { this.depth-- }
      return value
    } catch (error) {
      this.pending.splice(before)
      if (undo) { this.disk = undo; this.depth = 0 } else this.depth = level
      throw error
    }
  }

  /**
   * Commits every buffered write and waits for the earlier ones. Call before the process exits. A write made outside a
   * transaction, such as the loop's cursor, waits here too.
   */
  async flush(): Promise<void> {
    if (this.pending.length) this.queue = this.queue.then(() => this.commit(this.pending.splice(0))).catch(() => {})
    await this.queue
  }

  // Repositories

  readonly triggers = {
    get: (id: string): Trigger | undefined => this.findTrigger(id),
    save: (trigger: Trigger): void => {
      const at = trigger.at.replace(/[:.]/g, '-')
      this.write(join(this.triggerDir(threadKey(trigger.threads[0]!)), `${at}-${encode(trigger.id)}.json`), trigger)
    },
    list: (): Trigger[] => { const all: Trigger[] = []; for (const [name, value] of this.disk) if (name.startsWith('trigger:')) all.push(value as Trigger); return all },
    disposition: (id: string): TriggerDisposition | undefined => this.findMeta<TriggerDisposition>(`disposition:${id}`),
    saveDisposition: (id: string, value: TriggerDisposition): void => this.write(join('meta', `${encode(`disposition:${id}`)}.json`), value),
  }

  private findTrigger(id: string): Trigger | undefined {
    for (const [name, value] of this.disk) if (name.startsWith('trigger:') && (value as Trigger).id === id) return value as Trigger
    return undefined
  }

  private findMeta<T>(metaKey: string): T | undefined { return this.disk.get(`meta:${metaKey}`) as T | undefined }

  readonly threads = {
    get: (thread: string): Thread | undefined => this.disk.get(`thread:${thread}`) as Thread | undefined,
    save: (thread: Thread): void => this.write(join('threads', `${encode(thread.key)}.json`), thread),
    list: (): Thread[] => [...this.disk.entries()].filter(([name]) => name.startsWith('thread:')).map(([, value]) => value as Thread),
    active: (): Thread[] => this.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
  }

  readonly tickets = {
    get: (id: string): Ticket | undefined => this.disk.get(`ticket:${id}`) as Ticket | undefined,
    save: (ticket: Ticket): void => this.write(join('tickets', ticket.id, 'ticket.json'), ticket),
    list: (): Ticket[] => [...this.disk.entries()].filter(([name]) => name.startsWith('ticket:')).map(([, value]) => value as Ticket),
    open: (): Ticket[] => this.tickets.list().filter(ticket => ticket.ended === undefined),
    active: (): Ticket[] => this.tickets.list().filter(ticket => ticket.undelivered.length > 0 || ['pending', 'running'].includes(ticket.assignments.at(-1)?.state ?? '')),
  }

  readonly decisions = {
    get: (id: string): Decision | undefined => this.disk.get(`decision:${id}`) as Decision | undefined,
    save: (decision: Decision): void => this.write(join('decisions', `${encode(decision.id)}.json`), decision),
    byThread: (thread: string): Decision[] => this.decisions.list().filter(decision => decision.threadKey === thread),
    list: (): Decision[] => [...this.disk.entries()].filter(([name]) => name.startsWith('decision:')).map(([, value]) => value as Decision),
  }

  /** Stores arbitrary named state, such as a Source's cursor. */
  getMeta<T>(name: string): T | undefined { return this.findMeta<T>(name) }
  setMeta(name: string, value: unknown): void {
    if (value === undefined) this.remove(join('meta', `${encode(name)}.json`))
    else this.write(join('meta', `${encode(name)}.json`), value)
  }

  /** Every stored key, for `status` and debugging. */
  keys(): string[] { return [...this.disk.keys()].sort() }
}

/** Reads the state directory as plain files without opening it for writing, for a status command or an agent. */
export async function readState(stateDir: string): Promise<{ tickets: Ticket[]; threads: Thread[]; decisions: Decision[]; triggers: Trigger[]; exists: boolean }> {
  try { await stat(stateDir) } catch { return { tickets: [], threads: [], decisions: [], triggers: [], exists: false } }
  const repo = new FileRepositories(stateDir)
  await repo.open()
  return { tickets: repo.tickets.list(), threads: repo.threads.list(), decisions: repo.decisions.list(), triggers: repo.triggers.list(), exists: true }
}
