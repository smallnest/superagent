/**
 * The bridge between the Engine and an assessor: the model's judgement comes back asynchronously, and a round records it
 * as a Decision.
 *
 * An addressed request never reaches the model: a person named the agent, so nothing is in doubt, and an installation
 * with no assessor still runs the requests people make of it.
 */
import type { Assessment, Assessor, Candidate, Outcome } from './core/index.ts'
import { assessmentOutcome, UNASKED_RULE } from './policy.ts'
import type { Settings } from './settings.ts'

/** An assessment's verdict, which a round records as a Decision on the Trigger it judged. */
export type Decided = { triggerId: string; outcome: Outcome }

/** The name an addressed request gives its ticket: its first line without the mentions, short enough for a branch. */
export function named(candidate: Candidate): { title: string } {
  const text = candidate.triggers[0]?.text ?? ''
  return { title: text.split('\n')[0]!.replace(/@[\w-]+/g, '').trim().slice(0, 60) || 'Request' }
}

/**
 * The Assessor a loop installs: it judges each candidate in one model call, in flight beside the rounds.
 *
 * The call is asynchronous so a slow assessment never holds up a Source. Its outcome is a decision the loop makes: the
 * loop keeps one Engine across rounds, and a command run from this callback would see a Thread the round in flight is in
 * the middle of changing. A verdict for an Eval that ended meanwhile is dropped, and its requeued Triggers get a fresh one.
 */
export function assessing(options: { settings: () => Settings; next: (candidate: Candidate) => Promise<Assessment>
  decided: { push(item: Decided): void }; log: (line: string) => void }): Assessor {
  const running = new Map<string, Candidate>()
  return {
    request(candidate) {
      running.set(candidate.evalId, candidate)
      const explicit = candidate.strength === 'explicit'
      void (async () => {
        let outcome: Outcome
        try {
          const settings = options.settings()
          outcome = explicit
            ? { kind: 'accept', ...named(candidate), scope: '', reason: 'A person addressed the agent' }
            : assessmentOutcome(await options.next(candidate), settings, candidate.strength)
          // The `unasked` rule is what lets an unaddressed message start work; without it an accept has no authority.
          if (!explicit && outcome.kind === 'accept' && !settings.policy.rules.some(rule => rule.id === UNASKED_RULE)) {
            outcome = { kind: 'ignore', reason: 'The assessment accepts, but no `unasked` rule is enabled' }
          }
        } catch (error) {
          // A failed assessment is visible as `unavailable`, which a person can re-run, rather than as a quiet ignore.
          outcome = { kind: 'unavailable', reason: `The assessment could not run: ${(error as Error).message}` }
        }
        if (!running.has(candidate.evalId)) return
        running.delete(candidate.evalId)
        const triggerId = candidate.triggers[0]?.id
        if (triggerId) options.decided.push({ triggerId, outcome: { ...outcome, evalId: candidate.evalId } })
      })().catch(error => { options.log(`The assessment of ${candidate.evalId} failed: ${(error as Error).message}`) })
    },
    release(evalId) { running.delete(evalId) },
  }
}
