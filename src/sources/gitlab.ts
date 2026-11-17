/**
 * The GitLab Source: turns to-do items addressed to the agent and open merge requests into Triggers.
 *
 * GitLab delivers a mention, a direct address or an assignment to the agent's account as a to-do item, so the poll reads
 * `/todos` rather than every note in the project. A to-do carries the note's text, its author and the issue or merge
 * request it sits on, so a second request is not needed to know what the person wrote.
 *
 * The same project path and host reach a self-managed GitLab: `glab --hostname` chooses the instance, and every URL this
 * module builds names that host rather than gitlab.com.
 */
import { z } from 'zod'
import { key, threadKey, type ChannelRef, type ThreadRef, type Trigger } from '../core/index.ts'
import { run, runJson } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'

/** GitLab's API names a project by its URL-encoded namespace path, subgroups included. */
export const projectPath = (project: string): string => encodeURIComponent(project)
/** Web address of an issue or a merge request on the configured host. */
export const gitlabPage = (host: string, project: string, iid: number, mergeRequest = false): string =>
  `https://${host}/${project}/-/${mergeRequest ? 'merge_requests' : 'issues'}/${iid}`
/** A thread names its kind, because an issue and a merge request can share the same iid in one project. */
export const gitlabThread = (project: string, iid: number, mergeRequest = false): ThreadRef =>
  ({ source: SOURCE, id: `${project}${mergeRequest ? '!' : '#'}${iid}` })
export const gitlabChannel = (host: string, project: string, iid: number, kind: 'issue' | 'merge_request', url?: string): ChannelRef =>
  ({ source: SOURCE, thread: threadKey(gitlabThread(project, iid, kind === 'merge_request')),
    address: { host, project, number: String(iid), kind, ...url ? { url } : {} } })

/** True for an account GitLab reports as a bot rather than a person. */
export const isBot = (user: { username?: string | null; bot?: boolean | null } | null | undefined): boolean =>
  user?.bot === true || /_bot(?:\b|_)/.test(user?.username ?? '') || /\[bot\]$/.test(user?.username ?? '')

const PersonSchema = z.looseObject({ username: z.string().nullish(), name: z.string().nullish(), bot: z.boolean().nullish() }).nullish()
  .transform(user => user ?? { username: '', name: null, bot: null })

/** Actions that put a person's request in front of the agent. A build failure or an approval is not one. */
const ADDRESSING = new Set(['mentioned', 'directly_addressed', 'assigned', 'review_requested'])

/** A to-do item as `GET /todos` returns it. */
export const TodoSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  action_name: z.string(),
  target_type: z.string(),
  author: PersonSchema,
  target: z.looseObject({
    iid: z.number().nullish(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    web_url: z.string().nullish(),
    state: z.string().nullish(),
  }).nullish(),
  project: z.looseObject({ path_with_namespace: z.string().nullish() }).nullish(),
  body: z.string().nullish(),
  target_url: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
})
export type Todo = z.infer<typeof TodoSchema>

/**
 * Builds a Trigger from one to-do item, or `undefined` when it names no issue or merge request.
 *
 * `mentioned` and `directly_addressed` mean the person wrote to the agent; `assigned` and `review_requested` mean the
 * agent was handed the item without a mention, which is still a request aimed at the agent and no one else.
 */
export function todoTrigger(input: { todo: Todo; host: string; project: string; agent: string }): Trigger | undefined {
  const { todo, host, project, agent } = input
  const iid = todo.target?.iid
  if (!iid) return undefined
  const mergeRequest = todo.target_type === 'MergeRequest'
  const kind = mergeRequest ? 'merge_request' as const : 'issue' as const
  const username = todo.author?.username ?? ''
  const title = todo.target?.title?.trim() ?? ''
  const body = todo.body?.trim() || todo.target?.description?.trim() || ''
  const text = [title, body].filter(Boolean).join('\n\n') || '(the to-do carried no text)'
  const url = todo.target?.web_url ?? todo.target_url ?? gitlabPage(host, project, iid, mergeRequest)
  const at = todo.updated_at ?? todo.created_at ?? new Date().toISOString()
  const addressing = ADDRESSING.has(todo.action_name)
  return {
    id: key('gitlab-todo', project, String(todo.id)),
    source: SOURCE,
    threads: [gitlabThread(project, iid, mergeRequest)],
    actor: { source: SOURCE, id: username },
    human: !isBot(todo.author) && !sameName(username, agent),
    ...addressing ? { addressed: /mentioned|directly_addressed/.test(todo.action_name) ? 'mention' as const : 'direct' as const } : {},
    at,
    text,
    url,
    channel: gitlabChannel(host, project, iid, kind, url),
    meta: { number: iid, isPr: mergeRequest, kind, repository: project, host, author: username, action: todo.action_name },
  }
}

/** A merge request as `GET /projects/:id/merge_requests` returns it. */export const MergeRequestSchema = z.looseObject({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullish(),
  author: PersonSchema,
  updated_at: z.string().nullish(),
  web_url: z.string().nullish(),
  source_branch: z.string().nullish(),
  sha: z.string().nullish(),
  draft: z.boolean().nullish(),
  work_in_progress: z.boolean().nullish(),
})
export type MergeRequest = z.infer<typeof MergeRequestSchema>

/** The username the CLI acts as on `host`, which the Trigger builder uses to tell the agent's own work apart. */
export async function gitlabLogin(cli: string, host: string, signal?: AbortSignal): Promise<string> {
  const user = await runJson<{ username?: string }>(cli, apiArgs(host, 'user'), { signal })
  if (!user.username) throw new Error(`${cli} api user named no username on ${host}`)
  return user.username
}

/** One `glab api` call: the host is named every time, so a checkout cannot choose another GitLab by accident. */
const apiArgs = (host: string, path: string, extra: readonly string[] = []): string[] =>
  ['api', '--hostname', host, path, ...extra]

/**
 * Polls pending to-do items for the project and returns the Triggers not seen before.
 *
 * A to-do for another project is marked seen as well: the account may receive to-dos from everywhere, and only this
 * project's are this installation's work.
 */
export async function pollTodos(input: {
  cli: string
  host: string
  project: string
  agent: string
  signal?: AbortSignal
  seen: (id: string) => boolean
  mark: (id: string) => void
}): Promise<Trigger[]> {
  const todos = await runJson<Todo[]>(input.cli, apiArgs(input.host, 'todos?state=pending&per_page=100'), { signal: input.signal })
  const triggers: Trigger[] = []
  for (const todo of todos) {
    const id = `gitlab:todo:${todo.id}`
    if (input.seen(id)) continue
    input.mark(id)
    if (!sameName(todo.project?.path_with_namespace ?? '', input.project)) continue
    if (!ADDRESSING.has(todo.action_name)) continue
    const username = todo.author?.username ?? ''
    if (isBot(todo.author) || sameName(username, input.agent)) continue
    const trigger = todoTrigger({ todo, host: input.host, project: input.project, agent: input.agent })
    if (trigger) triggers.push(trigger)
  }
  return triggers
}

/**
 * Polls open merge requests and returns one Trigger per new or updated merge request.
 *
 * The key carries `updated_at`, so a push to the source branch asks for another review while an untouched merge request
 * is not reviewed twice.
 */
export async function pollOpenMergeRequests(input: {
  cli: string
  host: string
  project: string
  agent: string
  signal?: AbortSignal
  seen: (id: string) => boolean
  mark: (id: string) => void
}): Promise<Trigger[]> {
  const mergeRequests = await runJson<MergeRequest[]>(input.cli,
    apiArgs(input.host, `projects/${projectPath(input.project)}/merge_requests?state=opened&per_page=100`), { signal: input.signal })
  const triggers: Trigger[] = []
  for (const mergeRequest of mergeRequests) {
    const author = mergeRequest.author?.username ?? ''
    if (isBot(mergeRequest.author) || sameName(author, input.agent)) continue
    const at = mergeRequest.updated_at ?? new Date().toISOString()
    const id = key('gitlab-mr-review', input.project, String(mergeRequest.iid), at)
    if (input.seen(id)) continue
    input.mark(id)
    const url = mergeRequest.web_url ?? gitlabPage(input.host, input.project, mergeRequest.iid, true)
    triggers.push({
      id,
      source: SOURCE,
      threads: [gitlabThread(input.project, mergeRequest.iid, true)],
      actor: { source: SOURCE, id: author },
      human: true,
      addressed: 'mention',
      at,
      text: `# Merge Request Review: !${mergeRequest.iid} ${mergeRequest.title}\n\nAuthor: @${author}\nURL: ${url}\n\n${mergeRequest.description ?? ''}`,
      channel: gitlabChannel(input.host, input.project, mergeRequest.iid, 'merge_request', url),
      url,
      meta: { number: mergeRequest.iid, isPr: true, kind: 'pull_review', repository: input.project, host: input.host, author, updatedAt: at },
    })
  }
  return triggers
}

/** Posts a note on an issue or a merge request. */
export async function replyNote(input: {
  cli: string
  host: string
  project: string
  iid: number
  kind: 'issue' | 'merge_request'
  body: string
  signal?: AbortSignal
}): Promise<void> {
  const kind = input.kind === 'merge_request' ? 'merge_requests' : 'issues'
  await run(input.cli, apiArgs(input.host, `projects/${projectPath(input.project)}/${kind}/${input.iid}/notes`,
    ['--method', 'POST', '--raw-field', `body=${input.body}`]), { signal: input.signal })
}

/**
 * Merges a merge request, optionally only once its pipeline succeeds.
 *
 * GitLab decides whether a merge squashes by project settings, not per request, so `squash` asks for the project's
 * squash behaviour rather than naming a merge method.
 */
export async function mergeMergeRequest(input: {
  cli: string
  host: string
  project: string
  iid: number
  squash: boolean
  autoMerge: boolean
  signal?: AbortSignal
}): Promise<void> {
  await run(input.cli, apiArgs(input.host, `projects/${projectPath(input.project)}/merge_requests/${input.iid}/merge`, [
    '--method', 'PUT',
    '--field', `squash=${input.squash}`,
    ...input.autoMerge ? ['--field', 'merge_when_pipeline_succeeds=true'] : [],
  ]), { signal: input.signal })
}

/** Closes a merge request without merging it. */
export async function closeMergeRequest(input: { cli: string; host: string; project: string; iid: number; signal?: AbortSignal }): Promise<void> {
  await run(input.cli, apiArgs(input.host, `projects/${projectPath(input.project)}/merge_requests/${input.iid}`, [
    '--method', 'PUT', '--field', 'state_event=close',
  ]), { signal: input.signal })
}

/** An issue as `GET /projects/:id/issues` returns it. */
export const IssueSchema = z.looseObject({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string().nullish(),
  web_url: z.string().nullish(),
  updated_at: z.string().nullish(),
  author: PersonSchema,
  labels: z.array(z.string()).nullish(),
})
export type Issue = z.infer<typeof IssueSchema>

/** The open issues carrying `label`, which is the workflow's queue. */export async function listOpenIssues(input: {
  cli: string
  host: string
  project: string
  label: string
  signal?: AbortSignal
}): Promise<Issue[]> {
  return runJson<Issue[]>(input.cli, apiArgs(input.host,
    `projects/${projectPath(input.project)}/issues?state=opened&labels=${encodeURIComponent(input.label)}&per_page=100`), { signal: input.signal })
}

/**
 * Builds the Trigger the workflow proposes for one issue.
 *
 * It is `addressed: 'direct'`: the issue was chosen by the queue, not mentioned by someone, so the policy admits it as a
 * direct request from its author.
 */
export function issueTrigger(input: { issue: Issue; host: string; project: string }): Trigger {
  const { issue, host, project } = input
  const username = issue.author?.username ?? ''
  const url = issue.web_url ?? gitlabPage(host, project, issue.iid)
  return {
    id: key('gitlab-issue', project, String(issue.iid)),
    source: SOURCE,
    threads: [gitlabThread(project, issue.iid)],
    actor: { source: SOURCE, id: username },
    human: !isBot(issue.author),
    addressed: 'direct',
    at: issue.updated_at ?? new Date().toISOString(),
    text: `${issue.title}\n\n${issue.description ?? ''}`,
    url,
    channel: gitlabChannel(host, project, issue.iid, 'issue', url),
    meta: { number: issue.iid, isPr: false, kind: 'issue', repository: project, host, author: username, workflow: true },
  }
}

/** Closes an issue, which the operator confirmed in Feishu. */
export async function closeIssue(input: { cli: string; host: string; project: string; iid: number; signal?: AbortSignal }): Promise<void> {
  await run(input.cli, apiArgs(input.host, `projects/${projectPath(input.project)}/issues/${input.iid}`, [
    '--method', 'PUT', '--field', 'state_event=close',
  ]), { signal: input.signal })
}

/** One issue as GitLab has it now, which is how the workflow notices an issue closed outside it. */
export async function getIssue(input: { cli: string; host: string; project: string; iid: number; signal?: AbortSignal }): Promise<Issue> {
  return runJson<Issue>(input.cli, apiArgs(input.host, `projects/${projectPath(input.project)}/issues/${input.iid}`), { signal: input.signal })
}
