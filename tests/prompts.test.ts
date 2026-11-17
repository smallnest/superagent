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

  it('tells a shared checkout to commit on its own branch, not a per-ticket one', () => {
    const text = composePrompt({
      ticket: { id: 't3', title: 'Migrate an edge' } as never, trigger: undefined, repository: 'backend/dora-service',
      agentLogin: 'agent', branchPrefix: 'personal/smallnest/eventbus-', instructions: '', shared: true, mergeInto: 'release/test',
    })
    expect(text).toContain('long-lived development branch')
    expect(text).toContain('do not create a per-ticket branch')
    expect(text).toContain('Merge the pull request into `release/test`')
  })

  it('carries the memory rules and the reflect step for a workflow ticket', () => {
    const text = composePrompt({
      ticket: { id: 't4', title: 'Migrate an edge' } as never, trigger: undefined, repository: 'backend/dora-service',
      agentLogin: 'agent', branchPrefix: 'personal/smallnest/eventbus-', instructions: '',
      memory: ['- 2026-11-17 gRPC 大包必须调 HTTP/2 窗口'], reflect: true,
    })
    expect(text).toContain('## Memory')
    expect(text).toContain('gRPC 大包必须调 HTTP/2 窗口')
    expect(text).toContain('`LESSONS.md`')
  })

  it('carries a note the Engine recorded, as quoted material, before the rules of work', () => {
    const text = composePrompt({ ticket: { id: 't1', title: 'Fix the heading' } as never, trigger: undefined, repository: 'alice/widget',
      agentLogin: 'agent', branchPrefix: 'agent/', instructions: '', notes: ['The host restarted during this ticket. Inspect the worktree first.'] })
    expect(text).toContain('## Notes since the start')
    expect(text).toContain('> The host restarted during this ticket.')
    expect(text.indexOf('## Notes since the start')).toBeLessThan(text.indexOf('## How to work'))
  })

  it('includes autonomous run bounds when readOnly is true', () => {
    const text = composePrompt({
      ticket: { id: 't2', title: 'Check issue' } as never,
      trigger: undefined,
      repository: 'alice/widget',
      agentLogin: 'agent',
      branchPrefix: 'agent/',
      instructions: '',
      readOnly: true,
    })
    expect(text).toContain('Autonomous run mode')
    expect(text).toContain('do NOT push commits')
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
