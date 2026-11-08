/**
 * Proves who may start work: a listed person who addresses the agent, and a listed person's unaddressed message only when
 * the Source observes the chat and the Policy is not off. An accepted candidate needs the `unasked` rule, a settled
 * direction, and `auto` mode; `observe` records what `auto` would accept instead.
 */
import { describe, expect, it } from 'vitest'
import { assessmentOutcome, buildPolicy, sourceScope, UNASKED_RULE } from '../src/policy.ts'
import { parseAssessment } from '../src/assess.ts'
import { parseYaml, SettingsSchema, type Settings } from '../src/settings.ts'

/** Settings with the rules written in YAML, read the way an installation reads them. */
const settings = (mode: 'off' | 'observe' | 'auto'): Settings => SettingsSchema.parse(parseYaml(`stateDir: /tmp/state
checkout: /tmp/checkout
feishu:
  enabled: true
  chats:
    - chatId: oc_team
      name: Team
  allowed: [ou_alice]
github:
  enabled: true
  repository: acme/widgets
  allowed: [alice]
policy:
  mode: ${mode}
  rules:
    - id: ${UNASKED_RULE}
      name: Request
      instruction: The discussion asks for a concrete change.
    - id: docs
      name: Documentation
      instruction: The change is to a document.
`))

const message = (over: Record<string, unknown> = {}) => ({
  id: 't1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor: { source: 'feishu', id: 'ou_alice' },
  human: true, at: '2026-01-01T00:00:00.000Z', text: 'The README should say how to install it.', ...over,
}) as never

const thread = { key: 'feishu:oc_team:om_1' } as never

describe('the gate', () => {
  it('admits a listed person who addresses the agent, explicitly', () => {
    const gate = buildPolicy(settings('auto'), sourceScope(settings('auto'))).gate(message({ addressed: 'mention' }), thread, [])
    expect(gate).toEqual({ admissible: true, strength: 'explicit', basis: { via: 'listed', addressed: 'mention' } })
  })

  it('admits a listed person\'s unaddressed message where the Source observes the chat', () => {
    const gate = buildPolicy(settings('auto'), sourceScope(settings('auto'))).gate(message(), thread, [])
    expect(gate).toEqual({ admissible: true, strength: 'inferred', basis: { via: 'admission', cell: 'listedUnaddressed' } })
  })

  it('refuses an unaddressed message where the Source receives only addressed ones', () => {
    const policy = buildPolicy(settings('auto'), sourceScope(settings('auto')))
    const received = { listened: true, observed: false } as const
    expect(policy.gate(message(), thread, [], received)).toEqual({ admissible: false, reason: 'notAddressed' })
  })

  it('refuses a message from a person who is not listed, and from a bot', () => {
    const policy = buildPolicy(settings('auto'), sourceScope(settings('auto')))
    expect(policy.gate(message({ actor: { source: 'feishu', id: 'ou_bob' }, addressed: 'mention' }), thread, [])).toEqual({ admissible: false, reason: 'notAllowed' })
    expect(policy.gate(message({ human: false }), thread, [])).toEqual({ admissible: false, reason: 'bot' })
  })

  it('drops an unaddressed message before an assessment in `off` mode', () => {
    const off = settings('off')
    expect(buildPolicy(off, sourceScope(off)).gate(message(), thread, [])).toEqual({ admissible: false, reason: 'notAddressed' })
  })

  it('admits an inferred accept only in `auto` with every matched rule enabled', () => {
    expect(buildPolicy(settings('auto'), sourceScope(settings('auto'))).admitsInferred([UNASKED_RULE, 'docs'])).toBe(true)
    expect(buildPolicy(settings('auto'), sourceScope(settings('auto'))).admitsInferred(['unknown'])).toBe(false)
    expect(buildPolicy(settings('auto'), sourceScope(settings('auto'))).admitsInferred([])).toBe(false)
    const observe = settings('observe')
    expect(buildPolicy(observe, sourceScope(observe)).admitsInferred([UNASKED_RULE])).toBe(false)
  })
})

describe('the source scope', () => {
  it('observes every message in a chat the bot reads, and only the configured repository', () => {
    const scope = sourceScope(settings('auto'))
    expect(scope.scope({ source: 'feishu', meta: {} })).toEqual({ listened: true, observed: true })
    expect(scope.scope({ source: 'github', meta: { repository: 'ACME/Widgets' } })).toEqual({ listened: true, observed: false })
    expect(scope.scope({ source: 'github', meta: { repository: 'acme/other' } })).toEqual({ listened: false, reason: 'otherRepository' })
    expect(scope.scope({ source: 'slack', meta: {} })).toEqual({ listened: false, reason: 'unsupported' })
  })
})

describe('an assessment outcome', () => {
  const assessment = (over: Record<string, unknown> = {}) => ({
    decision: 'accept', title: 'Document the install', scope: 'The README gains a section.', reason: 'The README should say how to install it.',
    direction: { implementation_requested: true, target_basis: 'existing-standard', requires_design_decision: false, evidence: 'should say how to install it' },
    intent_evidence: 'should say how to install it', acknowledgement: null,
    rule_assessments: [{ rule_id: UNASKED_RULE, matched: true, reason: 'The message asks for a change to the README.' },
      { rule_id: 'docs', matched: true, reason: 'It changes a document.' }],
    ...over,
  })

  it('accepts a candidate the rules allow', () => {
    const outcome = assessmentOutcome(assessment() as never, settings('auto'), 'inferred')
    expect(outcome).toMatchObject({ kind: 'accept', title: 'Document the install', rules: [UNASKED_RULE, 'docs'] })
  })

  it('keeps only the matched rules when a rule does not match', () => {
    const outcome = assessmentOutcome(assessment({ rule_assessments: [
      { rule_id: UNASKED_RULE, matched: true, reason: 'Asks for a change.' }, { rule_id: 'docs', matched: false, reason: 'No document changes.' }],
    }) as never, settings('auto'), 'inferred')
    expect(outcome).toMatchObject({ kind: 'accept', rules: [UNASKED_RULE] })
  })

  it('requires a verdict for every enabled rule', () => {
    const missing = assessment({ rule_assessments: [{ rule_id: UNASKED_RULE, matched: true, reason: 'Asks.' }] })
    expect(() => assessmentOutcome(missing as never, settings('auto'), 'inferred')).toThrow(/docs/)
  })

  it('ignores a candidate without the unasked rule or a settled direction', () => {
    const rules = assessmentOutcome(assessment({ rule_assessments: [{ rule_id: UNASKED_RULE, matched: false, reason: 'A remark.' },
      { rule_id: 'docs', matched: true, reason: 'A document.' }] }) as never, settings('auto'), 'inferred')
    expect(rules).toMatchObject({ kind: 'ignore' })
    const unsettled = assessment({ direction: { implementation_requested: true, target_basis: 'undetermined', requires_design_decision: true, evidence: '' },
      rule_assessments: [{ rule_id: UNASKED_RULE, matched: true, reason: 'Asks for a change.' }, { rule_id: 'docs', matched: true, reason: 'A document.' }] })
    expect(assessmentOutcome(unsettled as never, settings('auto'), 'inferred')).toMatchObject({ kind: 'ignore', reason: 'The direction is not settled' })
  })

  it('records what `auto` would accept, as an ignored decision, in `observe` mode', () => {
    const observe = settings('observe')
    const outcome = assessmentOutcome(assessment() as never, observe, 'inferred')
    expect(outcome).toMatchObject({ kind: 'ignore', reason: 'Observe mode: would accept "Document the install"' })
    expect((outcome as { audit: Record<string, unknown> }).audit).toMatchObject({ would_accept: true })
  })

  it('accepts an addressed request the rules do not match', () => {
    const outcome = assessmentOutcome(assessment({ rule_assessments: [{ rule_id: UNASKED_RULE, matched: false, reason: 'No.' },
      { rule_id: 'docs', matched: false, reason: 'No.' }] }) as never, settings('auto'), 'explicit')
    expect(outcome).toMatchObject({ kind: 'ignore' })
  })
})

describe('parsing an assessment', () => {
  it('reads a fenced JSON object out of surrounding prose', () => {
    const text = 'Here is my answer:\n```json\n{"decision":"ignore","rule_assessments":[{"rule_id":"unasked","matched":false,"reason":"No request."}],"direction":null,"reason":"A remark."}\n```'
    expect(parseAssessment(text)).toMatchObject({ decision: 'ignore', reason: 'A remark.' })
  })

  it('rejects an accept without a settled direction, and text with no object', () => {
    expect(() => parseAssessment('{"decision":"accept","rule_assessments":[],"direction":{"implementation_requested":true,"target_basis":"undetermined","requires_design_decision":false,"evidence":""}}'))
      .toThrow(/settled direction/)
    expect(() => parseAssessment('I do not know.')).toThrow(/no JSON object/)
    // A model that answers `null` for the fields of a message it ignores still yields a verdict.
    expect(parseAssessment('{"decision":"ignore","rule_assessments":[],"direction":null,"title":null,"scope":null,"reason":"A remark."}'))
      .toMatchObject({ decision: 'ignore', title: '', scope: '', reason: 'A remark.' })
  })
})
