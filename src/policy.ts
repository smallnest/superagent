/**
 * How an installation decides who may start work: an explicit request from a listed person, or an owner's unaddressed
 * message that an assessment matches to an enabled rule.
 *
 * The admission table is kept whole here rather than simplified to "listed and addressed": a message that carries no
 * request is still worth assessing when the owner wrote it in a chat the Source reads, because many real requests are a
 * suggestion, not an order. `policy.mode` decides whether such a candidate is accepted (`auto`), only recorded
 * (`observe`), or dropped before an assessment (`off`).
 */
import { directionAllowed, type Assessment, type GateResult, type ScopeResult, type SourceScope, type Strength, type Thread, type Ticket, type Trigger } from './core/index.ts'
import type { Settings } from './settings.ts'

/** Which sources this installation's Sources read, and whether they read every message in that scope. */
export function sourceScope(settings: Settings): SourceScope {
  return { scope: input => {
    if (input.source === 'feishu') {
      if (!settings.feishu?.enabled) return { listened: false, reason: 'sourceOff' }
      // The bot is in the chat and receives every message there; `chats` names what it reads.
      return { listened: true, observed: true }
    }
    if (input.source !== 'github') return { listened: false, reason: 'unsupported' }
    if (!settings.github?.enabled) return { listened: false, reason: 'sourceOff' }
    const repository = (input.meta.repository as string | undefined) ?? settings.github.repository
    if (!repository) return { listened: false, reason: 'unsupported' }
    if (repository.toLowerCase() !== settings.github.repository.toLowerCase()) return { listened: false, reason: 'otherRepository' }
    return { listened: true, observed: false }
  } }
}

/** The rule a person's unaddressed chat message must match before its candidate may be accepted. */
export const UNASKED_RULE = 'unasked'

/** The Policy of one settings file, rebuilt whenever the round reads it. */
export function buildPolicy(settings: Settings, scope: ReturnType<typeof sourceScope>) {
  const people = (source: string): Set<string> => new Set((source === 'feishu' ? settings.feishu?.allowed : settings.github?.allowed)?.map(id => id.toLowerCase()) ?? [])
  return {
    version: `${settings.policy.mode}:${settings.policy.rules.filter(rule => rule.enabled).map(rule => rule.id).join(',')}`,
    paused: false,
    evalTimeoutMs: 120_000,
    gate: (trigger: Trigger, _thread: Thread, _tickets: Ticket[], received?: ScopeResult): GateResult => {
      if (!trigger.human) return { admissible: false, reason: 'bot' }
      const allowed = people(trigger.source).has(trigger.actor.id.toLowerCase())
      // Observed, not merely listened: this installation may accept what the Source receives unaddressed. A Source that
      // passes its own answer (GitHub, whose notifications are addressed) says so, since its Threads carry no scope in meta.
      const seen = received ?? scope.scope(trigger)
      const observed = seen.listened && seen.observed
      const addressed = !!trigger.addressed
      const basis = addressed ? { via: 'listed' as const, addressed: trigger.addressed } : { via: 'admission' as const, cell: 'listedUnaddressed' as const }
      if (allowed && addressed) return { admissible: true, strength: 'explicit', basis }
      // Only the owner's unaddressed words in a scope the Source reads enter an assessment; everything else is noise.
      if (allowed && observed && settings.policy.mode !== 'off') return { admissible: true, strength: 'inferred', basis }
      return { admissible: false, reason: allowed ? 'notAddressed' : 'notAllowed' }
    },
    revalidate: () => true,
    admitsInferred: (rules: readonly string[]) => settings.policy.mode === 'auto' && rules.length > 0
      && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
  }
}

/**
 * The decision an assessment reaches, as a Validation: an accepted candidate needs the `unasked` rule, then one verdict
 * for every enabled rule. `observe` records what `auto` would accept as an ignored Decision, so a person can read the
 * judgements before any of them starts work.
 */
export function assessmentOutcome(assessment: Assessment, settings: Settings, strength: Strength) {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = new Map(assessment.rule_assessments.map(item => [item.rule_id, item]))
  const missing = enabled.filter(rule => !judged.has(rule.id))
  if (missing.length) throw new Error(`No verdict for the rule(s) ${missing.map(rule => rule.id).join(', ')}`)
  const matches = enabled.filter(rule => judged.get(rule.id)!.matched).map(rule => rule.id)
  const audit = { rule_assessments: assessment.rule_assessments, direction: assessment.direction, intent_evidence: assessment.intent_evidence }
  if (assessment.decision !== 'accept') return { kind: assessment.decision as 'ignore' | 'unavailable', reason: assessment.reason, audit }
  if (!matches.length) return { kind: 'ignore' as const, audit, reason: 'No enabled rule matches this message' }
  // A matched rule is necessary, not sufficient: the assessment must also establish that a change was asked for, at a
  // target or standard that already exists, with no design decision left open.
  if (!directionAllowed(assessment.direction)) {
    return { kind: 'ignore' as const, audit, reason: assessment.intent_evidence ? 'The direction is not settled' : 'The assessment gives no evidence of intent' }
  }
  if (strength === 'inferred' && !matches.includes(UNASKED_RULE)) {
    return { kind: 'ignore' as const, audit, reason: 'The message does not ask for work; only the unasked rule can accept one' }
  }
  const accept = { kind: 'accept' as const, title: assessment.title, scope: assessment.scope, reason: assessment.reason, rules: matches, audit,
    ...assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {} }
  if (strength === 'inferred' && settings.policy.mode !== 'auto') {
    return { kind: 'ignore' as const, reason: `Observe mode: would accept "${assessment.title}"`, audit: { ...audit, would_accept: true, proposal: accept } }
  }
  return accept
}
