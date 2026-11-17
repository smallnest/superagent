/**
 * The whole configuration of an installation, in one file a person can read and edit.
 *
 * `settings.yaml` sits beside the state so `cat` answers "how is this set up". The parser below accepts the small YAML
 * subset a configuration needs — mappings, sequences, scalars, block strings — rather than adding a YAML dependency to a
 * tool that runs from a checkout. Writing uses the same subset, so round trips stay readable.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AGENT_NAMES } from './agents/index.ts'

const ExecutorSchema = z.object({
  /** Which coding agent runs a ticket. */
  agent: z.enum(AGENT_NAMES as [string, ...string[]]).default('claude'),
  /** The CLI to start for that agent; defaults to the agent's own name on PATH. */
  binary: z.string().optional(),
  /** The model argument, when the agent takes one. */
  model: z.string().optional(),
  /** How long a round waits for the event stream to send its first line, since a push may arrive at once. */
  streamIdleMs: z.number().int().min(1).max(60_000).default(300),
  /** How many tickets may run at once. */
  maxWorkers: z.number().int().min(1).max(16).default(1),
  /** A ticket that runs longer than this is stopped. */
  timeoutMinutes: z.number().int().min(1).max(720).default(60),
  /** Shell command that prepares a worktree; `$DSH_SUPERAGENT_*` variables are set before it runs. */
  prepare: z.string().default(''),
  /** Commands a ticket may not run. */
  blockedCommands: z.array(z.string()).default([]),
  /** Whether each ticket gets its own worktree and branch. False runs in `checkout`, on its current branch. */
  worktree: z.boolean().default(true),
})

const RuleSchema = z.object({
  /** The id an assessment names; `unasked` is reserved for the verdict that a message asks for work at all. */
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/, 'lowercase letters, digits, _ and -'),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** What kind of work the rule admits, in the words the assessor reads. */
  instruction: z.string().min(1),
})

/** Proactive work: whether an unaddressed message of the owner may become a ticket, and the rules that bound it. */
const PolicySchema = z.object({
  /** `off` never assesses an unaddressed message, `observe` records what it would accept, `auto` accepts it. */
  mode: z.enum(['off', 'observe', 'auto']).default('observe'),
  rules: z.array(RuleSchema).default([]),
})

export const AttentionSchema = z.object({
  idleSecondsThreshold: z.number().int().min(10).max(86400).default(300),
  quietHours: z.object({
    enabled: z.boolean().default(true),
    start: z.string().default('23:00'),
    end: z.string().default('08:00'),
    morningDigestAt: z.string().default('08:30'),
  }).default({ enabled: true, start: '23:00', end: '08:00', morningDigestAt: '08:30' }),
  minNotifyIntervalMinutes: z.number().int().min(1).max(1440).default(10),
  maxDailyNotifications: z.number().int().min(1).max(1000).default(25),
})

export const BudgetSchema = z.object({
  autonomousCooldownSeconds: z.number().int().min(0).max(86400).default(180),
  maxAutonomousWakesPerDay: z.number().int().min(1).max(1000).default(48),
})

export const TimerScheduleSchema = z.object({
  id: z.string().min(1),
  cron: z.string().optional(),
  intervalMinutes: z.number().int().min(1).optional(),
  prompt: z.string().min(1),
})

export const TimersSchema = z.object({
  enabled: z.boolean().default(true),
  schedules: z.array(TimerScheduleSchema).default([]),
})

export const WatcherSchema = z.object({
  id: z.string().min(1),
  intervalMinutes: z.number().int().min(1).default(10),
  command: z.string().min(1),
  instruction: z.string().min(1),
})

export const PrReviewSchema = z.object({
  /** Whether autonomous PR review is enabled. */
  enabled: z.boolean().default(true),
  /** When true, actively polls open PRs in the repository. */
  pollOpenPrs: z.boolean().default(true),
  /** Commands to run locally inside the worktree to verify the PR, e.g. ["npm test", "npm run build"]. */
  verifyCommands: z.array(z.string()).default([]),
  /** Timeout in seconds for each verify command. Default 300s. */
  verifyTimeoutSeconds: z.number().int().min(10).max(3600).default(300),
  /** Whether to automatically merge the PR if tests pass and review passes. */
  autoMerge: z.boolean().default(false),
  /** Method to use when auto-merging: "squash" | "merge" | "rebase". Default "squash". */
  mergeMethod: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  /** Whether community PRs (from authors not explicitly in allowed list) may be reviewed. */
  allowCommunityPrs: z.boolean().default(true),
})

export type PrReview = z.infer<typeof PrReviewSchema>

/** Merge request review on GitLab: the same work as `PrReviewSchema`, with GitLab's squash-instead-of-method. */
export const MrReviewSchema = z.object({
  /** Whether autonomous merge request review is enabled. */
  enabled: z.boolean().default(true),
  /** When true, actively polls open merge requests in the project. */
  pollOpenMrs: z.boolean().default(true),
  /** Commands to run locally inside the worktree to verify the merge request, e.g. ["npm test"]. */
  verifyCommands: z.array(z.string()).default([]),
  /** Timeout in seconds for each verify command. Default 300s. */
  verifyTimeoutSeconds: z.number().int().min(10).max(3600).default(300),
  /** Whether to merge the merge request if verification and review both pass. */
  autoMerge: z.boolean().default(false),
  /** Whether the merge squashes the commits. GitLab applies its project setting when this is false. */
  squash: z.boolean().default(true),
  /** Whether merge requests from authors not explicitly in the allowed list may be reviewed. */
  allowCommunityMrs: z.boolean().default(true),
})

export type MrReview = z.infer<typeof MrReviewSchema>

/**
 * The issue-by-issue workflow: propose one labeled issue, ask the operator in Feishu, run it only after a yes, and
 * close it only after a second yes. The bot asks in a direct message to `user`.
 */
export const WorkflowSchema = z.object({
  enabled: z.boolean().default(false),
  /** Open issues with this label form the queue; the Phase 0 issue comes first, then iid ascending. */
  label: z.string().min(1).default('superagent'),
  /** The Feishu open id the bot asks, in a direct message. */
  user: z.string().min(1),
  /** The branch a ticket merges its request into, such as `release/test`; empty means a person merges it. */
  mergeInto: z.string().default('release/test'),
  /** The most rules the memory keeps; the oldest goes when a new one makes the list longer. */
  memoryLines: z.number().int().min(5).max(200).default(40),
  /** How often the bot sends the rules back for a person to delete what is wrong. */
  reviewDays: z.number().int().min(1).max(365).default(7),
  /** Commands run in the ticket's worktree after the turn; their output joins the summary. */
  verifyCommands: z.array(z.string()).default([]),
})

export type Workflow = z.infer<typeof WorkflowSchema>

/** A host as `gitlab.host` names it: a DNS name or address, optionally with a port for a self-managed instance. */
const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/
/** A project path, subgroups included: `group/project` or `group/subgroup/project`. */
const PROJECT = /^[\w.-]+(?:\/[\w.-]+)+$/


export const SettingsSchema = z.object({
  /** Where tickets, triggers and logs live, as an absolute path. */
  stateDir: z.string().min(1),
  /** The directory whose clone each ticket's worktree comes from. */
  checkout: z.string().min(1),
  github: z.object({
    enabled: z.boolean().default(true),
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/name'),
    /** The CLI that acts as the agent's account, such as `gh-agent`. */
    cli: z.string().default('gh'),
    /** How often to poll notifications, in seconds. */
    pollSeconds: z.number().int().min(15).max(3600).default(60),
    /** GitHub logins that may ask for work. Empty accepts nobody. */
    allowed: z.array(z.string()).default([]),
    /** Pull request review, checkout, and verification settings. */
    prReview: PrReviewSchema.optional(),
  }).optional(),
  feishu: z.object({
    enabled: z.boolean().default(true),
    /** The CLI that acts as the bot. */
    cli: z.string().default('lark-cli'),
    /** Chats to listen to, by id, with the display name the agent uses when it mentions them. */
    chats: z.array(z.object({ chatId: z.string(), name: z.string() })).default([]),
    /** Whether a direct message to the bot may become a ticket. */
    directMessages: z.boolean().default(true),
    /** Feishu open ids that may ask for work; `syncChat`, when set, fills this list from the chat's members. */
    allowed: z.array(z.string()).default([]),
    syncChat: z.string().optional(),
  }).optional(),
  twitter: z.object({
    enabled: z.boolean().default(true),
    /** The CLI that acts as Twitter client (opencli). */
    cli: z.string().default('opencli'),
    /** Search query or keywords to monitor (e.g. "superagent OR @smallnest"). */
    query: z.string().min(1),
    /** How often to poll Twitter search, in seconds. */
    pollSeconds: z.number().int().min(15).max(3600).default(300),
    /** Twitter handles that may trigger tickets; empty accepts any user matching the query. */
    allowed: z.array(z.string()).default([]),
  }).optional(),
  gitlab: z.object({
    enabled: z.boolean().default(true),
    /** The instance to talk to: `gitlab.com`, or the host of a self-managed GitLab, optionally with a port. */
    host: z.string().regex(HOST, 'expected a host such as gitlab.com or git.example.com:8443').default('gitlab.com'),
    /** The project to work on, as `group/project`; subgroups are part of the path. */
    project: z.string().regex(PROJECT, 'expected group/project'),
    /** The CLI that acts as the agent's account, such as `glab-agent`. */
    cli: z.string().default('glab'),
    /** How often to poll to-do items, in seconds. */
    pollSeconds: z.number().int().min(15).max(3600).default(60),
    /** GitLab usernames that may ask for work. Empty accepts nobody. */
    allowed: z.array(z.string()).default([]),
    /** Merge request review, checkout, and verification settings. */
    mrReview: MrReviewSchema.optional(),
  }).optional(),
  /** Issue-by-issue approval workflow, asked and confirmed in Feishu. */
  workflow: WorkflowSchema.optional(),
  executor: ExecutorSchema.optional().transform(value => ExecutorSchema.parse(value ?? {})),
  policy: PolicySchema.optional().transform(value => PolicySchema.parse(value ?? {})),
  /** Who assesses a candidate and with what: the `claude` CLI, or a runner named here. */
  assess: z.object({
    agent: z.enum(AGENT_NAMES as [string, ...string[]]).default('claude'),
    binary: z.string().optional(),
    model: z.string().optional(),
  }).optional().transform(value => ({ agent: 'claude', ...value } as { agent: string; binary?: string; model?: string })),
  /** Branch names the agent pushes, as a prefix followed by the ticket's short name. */
  branchPrefix: z.string().default('agent/'),
  /** The operator's own instructions, appended to every ticket's prompt in their words. */
  prompts: z.string().default(''),
  /** Human presence and attention routing configuration. */
  attention: AttentionSchema.optional().transform(value => AttentionSchema.parse(value ?? {})),
  /** Token and autonomous wakeup protection guard. */
  budget: BudgetSchema.optional().transform(value => BudgetSchema.parse(value ?? {})),
  /** Autonomous timers and schedules. */
  timers: TimersSchema.optional().transform(value => TimersSchema.parse(value ?? {})),
  /** Pull-based active watchers for external sources without webhooks. */
  watchers: z.array(WatcherSchema).default([]),
}).strict().superRefine((settings, context) => {
  // One installation serves one forge: the worker's git credentials, the CLI shim and the review prompt each name one.
  if (settings.github?.enabled && settings.gitlab?.enabled) {
    context.addIssue({ code: 'custom', path: ['gitlab'],
      message: 'one installation serves one forge: set `github.enabled` or `gitlab.enabled` to false' })
  }
})

export type Settings = z.infer<typeof SettingsSchema>

/** The default an installation starts from, for `superagent init`. */
export function defaultSettings(cwd: string, home: string): Settings {
  return SettingsSchema.parse({
    stateDir: join(home, '.superagent'),
    checkout: cwd,
    executor: {},
  })
}

export const SETTINGS_FILE = 'settings.yaml'

export async function readSettings(path: string): Promise<Settings> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) {
    throw new Error(`No configuration at ${path}; run \`superagent init\` there first.`, { cause: error })
  }
  const parsed = SettingsSchema.safeParse(parseYaml(text))
  if (!parsed.success) throw new Error(`The configuration at ${path} is invalid:\n${formatIssues(parsed.error)}`)
  return parsed.data
}

export async function writeSettings(path: string, settings: Settings): Promise<void> {
  await writeFile(path, ['# superagent configuration', '# Edit by hand or through `superagent config set <path> <value>`.', '', stringifyYaml(settings), ''].join('\n'), 'utf8')
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map(issue => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')
}

// A deliberately small YAML subset: block mappings, block sequences, quoted and plain scalars, and `|` block strings.

type Node = string | number | boolean | null | Node[] | { [key: string]: Node }

/** Parses the configuration subset; indentation must be spaces and tabs are refused. */
export function parseYaml(text: string): unknown {
  const lines = text.split('\n')
  let index = 0

  const indentOf = (line: string): number => line.length - line.trimStart().length
  const isSkippable = (line: string): boolean => !line.trim() || line.trimStart().startsWith('#')

  function parseBlock(indent: number): Node {
    while (index < lines.length && isSkippable(lines[index]!)) index++
    if (index >= lines.length || indentOf(lines[index]!) < indent) return null
    const line = lines[index]!
    if (line.trimStart().startsWith('- ')) return parseSequence(indentOf(line))
    return parseMapping(indentOf(line))
  }

  function parseSequence(indent: number): Node[] {
    const items: Node[] = []
    while (index < lines.length) {
      const line = lines[index]!
      if (isSkippable(line)) { index++; continue }
      if (indentOf(line) < indent) break
      if (indentOf(line) > indent) throw new Error(`Unexpected indentation on line ${index + 1}`)
      const trimmed = line.trimStart()
      if (!trimmed.startsWith('- ')) break
      const rest = trimmed.slice(2).trim()
      index++
      if (!rest) { items.push(parseBlock(indent + 2)); continue }
      if (/^[\w.-]+:(\s|$)/.test(rest)) {
        // A mapping that starts on the sequence line: re-read it as a mapping at the item's indentation.
        lines[index - 1] = ' '.repeat(indent + 2) + rest
        index--
        items.push(parseMapping(indent + 2))
        continue
      }
      items.push(scalar(rest))
    }
    return items
  }

  function parseMapping(indent: number): { [key: string]: Node } {
    const map: { [key: string]: Node } = {}
    while (index < lines.length) {
      const line = lines[index]!
      if (isSkippable(line)) { index++; continue }
      if (indentOf(line) < indent) break
      if (indentOf(line) > indent) throw new Error(`Unexpected indentation on line ${index + 1}`)
      const trimmed = line.trimStart()
      const match = /^([\w.$-]+):(?:\s+(.*))?$/.exec(trimmed)
      if (!match) throw new Error(`Cannot read line ${index + 1}: ${trimmed}`)
      const [, name, rest = ''] = match
      index++
      if (rest === '|') {
        const body: string[] = []
        while (index < lines.length && (!lines[index]!.trim() || indentOf(lines[index]!) > indent)) {
          body.push(lines[index]!.slice(indent + 2)); index++
        }
        map[name!] = body.join('\n').replace(/\n+$/, '')
      } else if (rest.trim() === '') {
        while (index < lines.length && isSkippable(lines[index]!)) index++
        const next = lines[index]
        map[name!] = next && indentOf(next) > indent ? parseBlock(indentOf(next)) : null
      } else map[name!] = scalar(rest.trim())
    }
    return map
  }

  const value = parseBlock(0)
  return value ?? {}
}

function scalar(text: string): Node {
  if (text === 'null' || text === '~' || text === '') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number(text)
  if (text.startsWith('"') || text.startsWith("'")) {
    try { return JSON.parse(text.startsWith("'") ? `"${text.slice(1, -1).replace(/"/g, '\\"')}"` : text) } catch { return text.slice(1, -1) }
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    // A flow sequence of plain scalars, as `[docker, kubectl]` writes it.
    const body = text.slice(1, -1).trim()
    return body ? body.split(',').map(item => scalar(item.trim())) : []
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const body = text.slice(1, -1).trim()
    if (!body) return {}
    return Object.fromEntries(body.split(',').map(pair => {
      const [name, ...value] = pair.split(':')
      return [name!.trim(), scalar(value.join(':').trim())]
    }))
  }
  return text
}

/** Writes the same subset back, quoting only what would otherwise read as something else. */
export function stringifyYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent)
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') return needsQuote(value) ? JSON.stringify(value) : value
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value.map(item => {
      const nested = stringifyYaml(item, indent + 2)
      return typeof item === 'object' && item !== null ? `${pad}- ${nested.slice(indent + 2)}` : `${pad}- ${nested}`
    }).join('\n')
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
  if (entries.length === 0) return '{}'
  return entries.map(([name, item]) => {
    if (item !== null && typeof item === 'object' && (Array.isArray(item) ? item.length > 0 : Object.keys(item).length > 0)) {
      return `${pad}${name}:\n${stringifyYaml(item, indent + 2)}`
    }
    return `${pad}${name}: ${stringifyYaml(item, indent + 2)}`
  }).join('\n')
}

const needsQuote = (text: string): boolean => text === '' || /^[\s"'-]|[:#]|\s$|^(true|false|null|~|-?\d+(\.\d+)?)$/.test(text)
