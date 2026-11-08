/**
 * Proves the prompt a ticket's agent receives: it quotes the request, keeps the standing rules from `prompts/`, and ends
 * with the report contract the runners read.
 */
import { describe, expect, it } from 'vitest'
import { composePrompt, standingRules } from '../src/prompts.ts'
import { deliverable } from '../src/runner.ts'

const compose = (standing: string[], instructions = '') => composePrompt({
  ticket: { id: 't1', title: 'Fix the heading' } as never, trigger: undefined, repository: 'alice/widget', agentLogin: 'agent',
  branchPrefix: 'agent/', instructions, branch: 'agent/fix-the-heading-t1', standing,
})

describe('the prompt for a ticket', () => {
  it('carries every standing rule, the operator instructions, and the report contract', async () => {
    const standing = await standingRules()
    expect(standing).toHaveLength(2)
    const text = compose(standing, 'Commit as "alice" <alice@example.com>.')
    for (const rule of standing) expect(text).toContain(rule)
    expect(text).toContain('## Team instructions')
    expect(text).toContain('Commit as "alice"')
    expect(text).toContain('.superagent/report.json')
    expect(text).toContain('agent/fix-the-heading-t1')
  })

  it('leaves the instructions out when there are none', () => {
    expect(compose([])).not.toContain('## Team instructions')
  })
})

describe('the reply a person receives', () => {
  it('is the first sentence of the summary', () => {
    expect(deliverable('Fixed the heading. Also renamed a helper.')).toBe('Fixed the heading')
  })

  it('keeps a version or a file name whole', () => {
    expect(deliverable('Bumped zod to 4.4.3 in package.json')).toBe('Bumped zod to 4.4.3 in package.json')
  })

  it('ends a Chinese sentence at its mark', () => {
    expect(deliverable('已修复标题。另外清理了测试。')).toBe('已修复标题')
  })

  it('cuts a long sentence at the limit', () => {
    const text = deliverable('a'.repeat(400))
    expect(text).toHaveLength(200)
    expect(text.endsWith('…')).toBe(true)
  })

  it('falls back when the summary is empty', () => {
    expect(deliverable('   ')).toBe('The work is done.')
  })
})
