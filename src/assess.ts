/**
 * The assessment of a candidate a person did not address to the agent.
 *
 * One model call reads the messages in a Thread and the enabled rules, and answers one verdict per rule plus a direction:
 * whether a change was asked for, at a target or standard that already exists. The model never decides authority; the
 * Policy and the engine's `admitsInferred` do. A failed or malformed answer ends the assessment as `unavailable`, which a
 * person can see and re-run, rather than as a quiet ignore.
 */
import { z } from 'zod'
import { directionAllowed, RuleAssessmentSchema, type Assessment, type Candidate, type Thread, type Trigger } from './core/index.ts'
export type { Assessment }
import { runProcess } from './agents/process.ts'
import { UNASKED_RULE } from './policy.ts'
import type { Settings } from './settings.ts'

/** The JSON the assessor must print. */
export const AssessmentSchema = z.object({
  decision: z.enum(['accept', 'ignore', 'unavailable']),
  rule_assessments: z.array(RuleAssessmentSchema),
  direction: z.unknown(),
  // A model answers `null` for a field that does not apply, such as the title of a message it ignores.
  title: z.string().max(80).nullish().transform(value => value ?? ''),
  scope: z.string().max(500).nullish().transform(value => value ?? ''),
  reason: z.string().max(500).nullish().transform(value => value ?? ''),
  intent_evidence: z.string().max(700).nullable().default(null),
  acknowledgement: z.string().max(200).nullable().default(null),
})

/** The talk in a Thread, oldest first, each message cut so the prompt stays bounded. */
export function conversation(thread: Thread, triggers: Trigger[], limit = 12): string {
  const recent = triggers.slice(-limit)
  return recent.map(trigger => {
    const text = trigger.text.replace(/\s+/g, ' ').trim().slice(0, 1500)
    const who = trigger.human ? trigger.actor.id : 'a bot'
    const mark = trigger.addressed ? ' (addressed the agent)' : ''
    return `- [${trigger.id}] ${who}${mark} at ${trigger.at}: ${text}`
  }).join('\n')
}

/** The prompt one assessment reads: the rules it must judge, then the discussion. */
export function assessmentPrompt(candidate: Candidate, settings: Settings): string {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const rules = [
    `- \`${UNASKED_RULE}\` (The request): the discussion asks for a concrete change to this project, with a target or an`,
    '  existing standard to change it towards, and no open design decision. A preference, a hypothetical or a discussion of',
    '  another product does not match.',
    ...enabled.map(rule => `- \`${rule.id}\` (${rule.name}): ${rule.instruction}`),
  ]
  return [
    `# A message in a chat the agent reads, not addressed to it`,
    '',
    'Decide whether it asks for work. You do not do the work and you do not change anything.',
    '',
    '## Rules',
    '',
    ...rules,
    '',
    '## The discussion',
    '',
    conversation(candidate.thread, candidate.triggers),
    '',
    '## Answer',
    '',
    'Print one JSON object and nothing else:',
    '',
    '```json',
    '{"decision": "accept" | "ignore" | "unavailable",',
    ' "rule_assessments": [{"rule_id": "<id>", "matched": true, "reason": "<one sentence, factual>"}, ...],',
    ' "direction": {"implementation_requested": true, "target_basis": "specified" | "existing-standard" | "undetermined",',
    '               "requires_design_decision": false, "evidence": "<the words that establish it>"},',
    ' "title": "<a short name for the work, when accepting>",',
    ' "scope": "<what changes, in one sentence>",',
    ' "reason": "<one sentence for a person reading the decision>",',
    ' "intent_evidence": "<the quotation that shows the request>",',
    ' "acknowledgement": null}',
    '```',
    '',
    '- Include exactly one `rule_assessments` entry for every rule above, matched or not.',
    '- `accept` only when the discussion asks for a change the rules allow; otherwise `ignore`.',
    '- `unavailable` only when the discussion is unreadable.',
  ].join('\n')
}

/** Reads the JSON object out of what the model printed, tolerating a fenced block or surrounding prose. */
export function parseAssessment(text: string): Assessment {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('The assessment printed no JSON object')
  const parsed = AssessmentSchema.parse(JSON.parse(text.slice(start, end + 1)))
  if (parsed.decision === 'accept' && !directionAllowed(parsed.direction)) throw new Error('The assessment accepts without a settled direction')
  return parsed
}

/** A model call that judges one candidate, once per Eval: the engine asks once, and a replay of the same trigger comes as a new Eval. */
export function claudeAssessor(settings: Settings): (candidate: Candidate) => Promise<Assessment> {
  return async candidate => {
    const { agent, binary, model } = settings.assess
    if (agent !== 'claude') throw new Error(`The assessor runs on claude; settings.assess.agent is ${agent}`)
    // The agent's own credentials and its CLI wrappers make a ticket work; an assessment only reads, so it gets the plain ones.
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    const result = await runProcess(binary ?? 'claude', ['-p', '--output-format', 'json', ...model ? ['--model', model] : []], {
      cwd: settings.checkout,
      env,
      stdin: assessmentPrompt(candidate, settings),
      signal: AbortSignal.timeout(120_000),
      timeoutMs: 120_000,
    })
    if (result.exitCode !== 0) throw new Error(`The assessor exited ${result.exitCode}: ${result.stderr.slice(-500)}`)
    const envelope = JSON.parse(result.stdout) as { result?: string; is_error?: boolean }
    if (envelope.is_error) throw new Error(`The assessor failed: ${envelope.result ?? ''}`.slice(0, 500))
    return parseAssessment(envelope.result ?? '')
  }
}
