/**
 * The Twitter/X Source: searches keywords using `opencli twitter search` and turns feedback into Triggers,
 * and delivers responses back to the original tweet via `opencli twitter reply`.
 */
import { z } from 'zod'
import { key, threadKey, type ChannelRef, type ThreadRef, type Trigger } from '../core/index.ts'
import { run, runJson } from '../infra/commands.ts'

export const SOURCE = 'twitter'

export const TwitterTweetSchema = z.looseObject({
  id: z.string(),
  author: z.string(),
  text: z.string(),
  created_at: z.string().nullish(),
  url: z.string(),
})
export type TwitterTweet = z.infer<typeof TwitterTweetSchema>

export const twitterThread = (id: string): ThreadRef => ({ source: SOURCE, id })
export const twitterChannel = (url: string, id: string): ChannelRef => ({
  source: SOURCE,
  thread: threadKey(twitterThread(id)),
  address: { tweetUrl: url, tweetId: id },
})

export function tweetTrigger(tweet: TwitterTweet, agentLogin?: string): Trigger {
  const at = tweet.created_at ?? new Date().toISOString()
  const addressed = agentLogin && tweet.text.toLowerCase().includes(`@${agentLogin.toLowerCase()}`)
  return {
    id: key('twitter-tweet', tweet.id),
    source: SOURCE,
    threads: [twitterThread(tweet.id)],
    actor: { source: SOURCE, id: tweet.author },
    human: true,
    ...addressed ? { addressed: 'mention' as const } : {},
    at,
    text: tweet.text,
    url: tweet.url,
    channel: twitterChannel(tweet.url, tweet.id),
    meta: { tweetId: tweet.id, author: tweet.author },
  }
}

export async function searchTweets(
  cli: string,
  query: string,
  options: {
    limit?: number
    seen?: (id: string) => boolean
    mark?: (id: string) => void
    agentLogin?: string
    signal?: AbortSignal
  } = {},
): Promise<Trigger[]> {
  const limit = options.limit ?? 15
  const tweets = await runJson<TwitterTweet[]>(cli,
    ['twitter', 'search', query, '--product', 'live', '--limit', String(limit), '-f', 'json'],
    { signal: options.signal },
  )
  const list = Array.isArray(tweets) ? tweets : []
  const triggers: Trigger[] = []
  for (const item of list) {
    if (!item.id || !item.text) continue
    if (options.seen?.(item.id)) continue
    options.mark?.(item.id)
    triggers.push(tweetTrigger(item, options.agentLogin))
  }
  return triggers
}

export async function replyTweet(
  cli: string,
  tweetUrl: string,
  text: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await run(cli, ['twitter', 'reply', tweetUrl, text], { signal: options.signal })
}

export async function twitterAccount(cli: string, signal?: AbortSignal): Promise<string> {
  try {
    const info = await runJson<{ username?: string }>(cli, ['twitter', 'whoami', '-f', 'json'], { signal })
    return info.username ?? ''
  } catch {
    return ''
  }
}
