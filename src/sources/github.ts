/**
 * The GitHub Source: turns new mentions and new Issues in one repository into Triggers.
 *
 * GitHub delivers a mention to the agent's own account as a notification, so the poll reads notifications rather than
 * every Issue in the repository. The alternative — scanning the repository — costs a request per Issue and reports
 * mentions the agent may never have been able to answer.
 *
 * A notification only says that something mentioned the account. The comment itself is read afterwards, so the Trigger
 * carries what the person wrote, not the notification's summary.
 */
import { z } from 'zod'
import { key, threadKey, type ChannelRef, type ThreadRef, type Trigger } from '../core/index.ts'
import { runJson } from '../infra/commands.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'github'

/** A thread identifier for an Issue or pull request number; both share one sequence in GitHub. */
export const githubThread = (number: number): ThreadRef => ({ source: SOURCE, id: String(number) })
/** Where a reply to this number goes. */
export const githubChannel = (repository: string, number: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: threadKey(githubThread(number)), address: { number: String(number), repository, ...url ? { url } : {} } })
export const githubPage = (repository: string, number: number, pr = false): string =>
  `https://github.com/${repository}/${pr ? 'pull' : 'issues'}/${number}`

/** Whether `text` mentions `login` as a whole name rather than as a prefix of a longer one. */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)

/** True for an account GitHub reports as an ordinary user; a login ending in `[bot]` or an App is not one. */
export const isHumanLogin = (user: { login: string; type?: string | null }): boolean =>
  !/\[bot\]$/.test(user.login) && (!user.type || user.type === 'User')

const UserSchema = z.looseObject({ login: z.string(), type: z.string().nullish() }).nullish()
  .transform(user => user ?? { login: 'ghost', type: null })

/** A notification as `GET /notifications` returns it. */
export const NotificationSchema = z.looseObject({
  id: z.string(),
  reason: z.string(),
  updated_at: z.string(),
  subject: z.looseObject({ title: z.string(), url: z.string().nullish(), type: z.string(), latest_comment_url: z.string().nullish() }),
  repository: z.looseObject({ full_name: z.string(), owner: z.looseObject({ login: z.string() }).nullish() }).nullish(),
})
export type Notification = z.infer<typeof NotificationSchema>

/** A comment or review as `issues/<n>/comments` and `pulls/<n>/reviews` return it. */
export const CommentSchema = z.looseObject({
  id: z.number().nullish(),
  body: z.string().nullish(),
  user: UserSchema,
  html_url: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  submitted_at: z.string().nullish(),
  state: z.string().nullish(),
})
export type Comment = z.infer<typeof CommentSchema>

/** Pulls `owner/repo#number` out of a notification subject URL, for the repository the Source watches. */
export function notificationNumber(notification: Notification): { number: number; pr: boolean } | undefined {
  const match = /\/(?:issues|pulls)\/(\d+)\/?$/.exec(notification.subject.url ?? '')
  if (!match) return undefined
  return { number: Number(match[1]), pr: notification.subject.type === 'PullRequest' }
}

/** Reads the comment a notification points at; a notification without a comment URL is a new Issue, which has none. */
export async function notificationComment(notification: Notification, cli: string, repository: string): Promise<Comment | undefined> {
  const url = notification.subject.latest_comment_url
  if (!url) return undefined
  // `gh api` takes the path under the API root, so `repos/` stays; the repository must be the one this Source watches.
  if (!url.includes(`/api.github.com/repos/${repository}/`)) return undefined
  const path = url.replace(/^https:\/\/api\.github\.com\//, '')
  try { return await runJson<Comment>(cli, ['api', path]) } catch { return undefined }
}

/** Builds a Trigger for a decision to accept or ignore a comment. `kind` names whether it sits on an Issue, a PR or a review. */
export function commentTrigger(input: {
  repository: string
  number: number
  pr: boolean
  comment: Comment
  agent: string
  kind: 'conversation' | 'review' | 'issue'
}): Trigger {
  const { repository, number, pr, comment, agent, kind } = input
  const at = comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? new Date().toISOString()
  const text = [comment.state && comment.state !== 'COMMENTED' ? `${comment.state} review` : '', comment.body ?? ''].filter(Boolean).join('\n\n')
  const url = comment.html_url ?? githubPage(repository, number, pr)
  const login = comment.user.login
  return {
    id: key('github-comment', url, String(comment.id ?? ''), at),
    source: SOURCE,
    threads: [githubThread(number)],
    actor: { source: SOURCE, id: login },
    human: isHumanLogin(comment.user) && !sameName(login, agent),
    ...(mentions(comment.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    at,
    text,
    channel: githubChannel(repository, number, url),
    url,
    meta: { number, isPr: pr, repository, commentId: comment.id ?? null, kind },
  }
}

/** Builds a Trigger for a new Issue or pull request, whose title and body are the text a person wrote. */
export function issueTrigger(input: { repository: string; number: number; pr: boolean; title: string; body?: string | null
  user: { login: string; type?: string | null }; at: string; url: string; agent: string }): Trigger {
  const { repository, number, pr, title, body, user, at, url, agent } = input
  return {
    id: key('github-issue', repository, String(number)),
    source: SOURCE,
    threads: [githubThread(number)],
    actor: { source: SOURCE, id: user.login },
    human: isHumanLogin(user) && !sameName(user.login, agent),
    ...(mentions(`${title}\n${body ?? ''}`, agent) ? { addressed: 'mention' as const } : {}),
    at,
    text: `${title}\n\n${body ?? ''}`,
    channel: githubChannel(repository, number, url),
    url,
    meta: { number, isPr: pr, repository, kind: pr ? 'pull' : 'issue' },
  }
}

/** The name a CLI reports for the account it acts as, which the Trigger builder uses to tell the agent's own messages apart. */
export async function agentLogin(cli: string, signal?: AbortSignal): Promise<string> {
  return (await runJson<{ login: string }>(cli, ['api', 'user'], { signal })).login
}

/**
 * Polls one round of notifications for `repository` and returns the Triggers it has not seen.
 * `since` is the ISO time of the previous round, or the moment the Source first ran.
 */
export async function pollNotifications(input: {
  cli: string
  repository: string
  agent: string
  since: string
  signal: AbortSignal
  seen: (id: string) => boolean
  mark: (id: string) => void
}): Promise<Trigger[]> {
  const notifications = await runJson<Notification[]>(input.cli, ['api', `notifications?all=false&participating=false&since=${encodeURIComponent(input.since)}`], { signal: input.signal })
  const triggers: Trigger[] = []
  for (const notification of notifications) {
    if (!sameName(notification.repository?.full_name ?? '', input.repository)) continue
    if (!/mention|assign|review_requested|comment/.test(notification.reason)) continue
    if (input.seen(notification.id)) continue
    const place = notificationNumber(notification)
    if (!place) { input.mark(notification.id); continue }
    const comment = await notificationComment(notification, input.cli, input.repository)
    if (!comment) { input.mark(notification.id); continue }
    // The agent's own comment reaches its notifications too; it is not a request from a person.
    if (sameName(comment.user.login, input.agent)) { input.mark(notification.id); continue }
    if (!mentions(comment.body ?? '', input.agent)) { input.mark(notification.id); continue }
    triggers.push(commentTrigger({ repository: input.repository, number: place.number, pr: place.pr, comment, agent: input.agent, kind: 'conversation' }))
    input.mark(notification.id)
  }
  return triggers
}

export const PullRequestItemSchema = z.looseObject({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
  author: UserSchema,
  updatedAt: z.string().nullish(),
  url: z.string().nullish(),
  headRefName: z.string().nullish(),
  headRepositoryOwner: z.looseObject({ login: z.string() }).nullish(),
})
export type PullRequestItem = z.infer<typeof PullRequestItemSchema>

/**
 * Polls currently open pull requests for `repository` and returns Triggers for new or updated PRs.
 */
export async function pollOpenPullRequests(input: {
  cli: string
  repository: string
  agent: string
  signal?: AbortSignal
  seen: (id: string) => boolean
  mark: (id: string) => void
}): Promise<Trigger[]> {
  let prs: PullRequestItem[] = []
  try {
    prs = await runJson<PullRequestItem[]>(input.cli, [
      'pr', 'list',
      '--repo', input.repository,
      '--state', 'open',
      '--json', 'number,title,body,author,updatedAt,url,headRefName,headRepositoryOwner',
    ], { signal: input.signal })
  } catch {
    return []
  }

  const triggers: Trigger[] = []
  for (const pr of prs) {
    if (sameName(pr.author.login, input.agent)) continue
    const at = pr.updatedAt ?? new Date().toISOString()
    const prKey = key('github-pr-review', input.repository, String(pr.number), at)
    if (input.seen(prKey)) continue

    const url = pr.url ?? githubPage(input.repository, pr.number, true)
    triggers.push({
      id: prKey,
      source: SOURCE,
      threads: [githubThread(pr.number)],
      actor: { source: SOURCE, id: pr.author.login },
      human: isHumanLogin(pr.author) && !sameName(pr.author.login, input.agent),
      addressed: 'mention',
      at,
      text: `# Pull Request Review: #${pr.number} ${pr.title}\n\nAuthor: @${pr.author.login}\nURL: ${url}\n\n${pr.body ?? ''}`,
      channel: githubChannel(input.repository, pr.number, url),
      url,
      meta: {
        number: pr.number,
        isPr: true,
        kind: 'pull_review',
        repository: input.repository,
        author: pr.author.login,
        updatedAt: at,
      },
    })
    input.mark(prKey)
  }
  return triggers
}
