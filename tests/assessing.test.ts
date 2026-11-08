/**
 * Proves the bridge between the Engine and an assessor: an addressed request becomes an accept without a model call, an
 * unaddressed one takes the model's verdict, a failed call becomes `unavailable`, and a verdict for an Eval that ended
 * meanwhile is dropped.
 */
import { describe, expect, it } from 'vitest'
import { assessing, named, type Decided } from '../src/assessing.ts'
import { UNASKED_RULE } from '../src/policy.ts'
import { parseYaml, SettingsSchema, type Settings } from '../src/settings.ts'
import type { Assessment, Candidate } from '../src/core/index.ts'

const settings = (mode: 'observe' | 'auto', withRules = true): Settings => SettingsSchema.parse(parseYaml(`stateDir: /tmp/state
checkout: /tmp/checkout
policy:
  mode: ${mode}${withRules ? `
  rules:
    - id: ${UNASKED_RULE}
      name: Request
      instruction: The discussion asks for a concrete change.` : ''}
`))

const candidate = (strength: 'explicit' | 'inferred'): Candidate => ({
  evalId: 'eval-1', strength, policyVersion: 'auto:unasked', tickets: [],
  thread: { key: 'feishu:oc_team:om_1' } as never,
  triggers: [{ id: 't1', text: '@Agent please fix the heading\nand the link', human: true, actor: { source: 'feishu', id: 'ou_alice' } }] as never,
})

const accepted = (decision: 'accept'): Assessment => ({
  decision, title: 'Fix the heading', scope: 'The heading.', reason: 'A person asked.', intent_evidence: 'please fix the heading',
  direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'fix the heading' },
  rule_assessments: [{ rule_id: UNASKED_RULE, matched: true, reason: 'Asks for a change.' }],
})

/** Runs the bridge for one candidate and returns what a round would decide. */
async function decide(options: { strength: 'explicit' | 'inferred'; settings: Settings; next?: () => Promise<Assessment>
  releaseBefore?: boolean }): Promise<Decided[]> {
  const decided: Decided[] = []
  let resolve!: (value: Assessment) => void
  const next = options.next ?? (() => new Promise<Assessment>(value => { resolve = value }))
  const assessor = assessing({ settings: () => options.settings, next, decided, log: () => {} })
  const item = candidate(options.strength)
  assessor.request(item)
  if (options.releaseBefore) assessor.release?.(item.evalId)
  resolve?.(accepted('accept'))
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return decided
}

describe('the assessing bridge', () => {
  it('accepts an addressed request at once, naming the ticket from its first line', async () => {
    const decided = await decide({ strength: 'explicit', settings: settings('observe') })
    expect(decided).toHaveLength(1)
    expect(decided[0]).toMatchObject({ triggerId: 't1', outcome: { kind: 'accept', title: 'please fix the heading', evalId: 'eval-1' } })
    expect(named(candidate('explicit'))).toEqual({ title: 'please fix the heading' })
  })

  it('takes the model verdict for an unaddressed message and records it as accepted', async () => {
    const decided = await decide({ strength: 'inferred', settings: settings('auto') })
    expect(decided[0]).toMatchObject({ triggerId: 't1', outcome: { kind: 'accept', rules: [UNASKED_RULE], evalId: 'eval-1' } })
  })

  it('accepts an unaddressed message only in `observe` as a would-accept', async () => {
    const decided = await decide({ strength: 'inferred', settings: settings('observe') })
    expect(decided[0]!.outcome).toMatchObject({ kind: 'ignore', reason: 'Observe mode: would accept "Fix the heading"' })
  })

  it('ignores an accept when no unasked rule is enabled', async () => {
    const decided = await decide({ strength: 'inferred', settings: settings('auto', false) })
    expect(decided[0]!.outcome).toMatchObject({ kind: 'ignore' })
  })

  it('records a failed call as unavailable, so a person can see it', async () => {
    const decided = await decide({ strength: 'inferred', settings: settings('auto'), next: async () => { throw new Error('The assessor exited 1') } })
    expect(decided[0]!.outcome).toMatchObject({ kind: 'unavailable', reason: 'The assessment could not run: The assessor exited 1' })
  })

  it('drops a verdict for an Eval that ended while the call ran', async () => {
    expect(await decide({ strength: 'inferred', settings: settings('auto'), releaseBefore: true })).toEqual([])
  })
})
