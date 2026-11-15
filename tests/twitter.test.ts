import { describe, expect, it } from 'vitest'
import { tweetTrigger, type TwitterTweet } from '../src/sources/twitter.ts'

describe('the twitter source', () => {
  it('turns a tweet into a trigger with channel and thread', () => {
    const tweet: TwitterTweet = {
      id: '1856789012345678901',
      author: 'alice',
      text: 'Found a bug in superagent CLI: json parser fails on empty arrays.',
      created_at: '2026-11-15T05:20:00.000Z',
      url: 'https://x.com/alice/status/1856789012345678901',
    }

    const trigger = tweetTrigger(tweet, 'smallnest')
    expect(trigger.source).toBe('twitter')
    expect(trigger.actor.id).toBe('alice')
    expect(trigger.threads[0]?.id).toBe('1856789012345678901')
    expect(trigger.channel?.address).toEqual({
      tweetUrl: 'https://x.com/alice/status/1856789012345678901',
      tweetId: '1856789012345678901',
    })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBeUndefined()
  })

  it('marks mention when tweet addresses the bot account', () => {
    const tweet: TwitterTweet = {
      id: '1856789012345678902',
      author: 'bob',
      text: '@smallnest please add twitter keyword monitoring to superagent!',
      created_at: '2026-11-15T05:21:00.000Z',
      url: 'https://x.com/bob/status/1856789012345678902',
    }

    const trigger = tweetTrigger(tweet, 'smallnest')
    expect(trigger.addressed).toBe('mention')
  })
})
