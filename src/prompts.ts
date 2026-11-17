/**
 * The prompt a ticket's agent receives.
 *
 * It is assembled here rather than read from files so that an installation has one thing to read: `settings.yaml`. The
 * team-editable part is `prompts.instructions`, which the operator writes in their own words.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ticket, Trigger } from './core/index.ts'
import { reportInstructions } from './agents/types.ts'

export interface PromptInput {
  ticket: Ticket
  trigger: Trigger | undefined
  repository: string
  agentLogin: string
  branchPrefix: string
  /** The operator's own instructions, appended before the report contract. */
  instructions: string
  /** The Source the request came from; a Feishu chat has no forge account to open a request from. */
  source?: 'github' | 'feishu' | 'gitlab'
  /** The branch the worktree was created on, which the agent pushes instead of naming one itself. */
  branch?: string
  /** The standing rules, from `standingRules`. */
  standing?: string[]
  /** Notes a person was sent, such as a recovery note after a restart, which a fresh turn has not read in a session. */
  notes?: string[]
  /** When true, informs the agent of autonomous read-only sandbox boundaries. */
  readOnly?: boolean
  /** Local PR verification results, when reviewing a pull request. */
  prVerification?: {
    passed: boolean
    markdown: string
  }
  /** True when the ticket is reviewing a pull request. */
  isPrReview?: boolean
  /** The PR number being reviewed. */
  prNumber?: number
  /** Whether auto-merging is permitted upon approval. */
  autoMergeAllowed?: boolean
}

/**
 * The rules that hold for every ticket, one file each beside this one.
 *
 * They were files in the DSH bundle, where an operator edited them in the panel; here the text is part of the install,
 * so it is read from the file next to the source rather than copied into this module.
 */
const STANDING_FILES = ['scope.md', 'delivery.md'] as const
const STANDING_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export async function standingRules(): Promise<string[]> {
  return Promise.all(STANDING_FILES.map(async name => (await readFile(join(STANDING_DIR, name), 'utf8')).trim()))
}

export async function prReviewRules(): Promise<string> {
  try {
    return (await readFile(join(STANDING_DIR, 'pr-review.md'), 'utf8')).trim()
  } catch {
    return ''
  }
}

/** The forge's own words, so a GitLab ticket is not told to open a pull request. */
const forgeWords = (source?: PromptInput['source']) => source === 'gitlab'
  ? { name: 'GitLab', request: 'merge request', Request: 'Merge Request', short: 'MR' }
  : { name: 'GitHub', request: 'pull request', Request: 'Pull Request', short: 'PR' }

/** Composes the prompt for reviewing and verifying a pull request or a merge request. */
export function composePrReviewPrompt(input: PromptInput): string {
  const { ticket, trigger, repository, agentLogin, instructions, standing = [], notes = [], prNumber, prVerification, autoMergeAllowed } = input
  const words = forgeWords(input.source)
  const asked = trigger
    ? `${words.Request} #${prNumber} details:\n\n${quote(trigger.text)}`
    : `${words.Request} #${prNumber} review:\n\n${quote(ticket.title)}`

  return [
    `# Ticket ${ticket.id} — ${words.Request} #${prNumber} Review & Verification`,
    '',
    `You are reviewing ${words.Request} #${prNumber} on repository \`${repository}\`.`,
    `The ${words.short}'s code has been checked out directly into this working directory.`,
    `Your ${words.name} account is \`${agentLogin}\`.`,
    '',
    `## The ${words.Request}`,
    '',
    asked,
    ...notes.filter(Boolean).flatMap(note => ['', '## Notes since the start', '', quote(note)]),
    '',
    '## Automated Local Verification Report',
    '',
    prVerification ? prVerification.markdown : 'No automated verification commands were configured.',
    '',
    '## Review Instructions & Standards',
    '',
    '- **Inspect Every Line**: Scrutinize the git diff and logic changes. Do not blindly trust community submissions.',
    '- **Zero Tolerance for AI Slop**: Many requests are generated hastily by coding agents without testing. Ensure logic is sound, error handling is thorough, and no regressions are introduced.',
    ...(prVerification && !prVerification.passed ? [
      `- ⚠️ **CRITICAL: Local automated verification has FAILED.** You MUST NOT approve or merge this ${words.request}. Clearly point out the failure logs and what the author needs to fix.`,
    ] : []),
    '- **Decision Standards**:',
    autoMergeAllowed && (!prVerification || prVerification.passed)
      ? '  - Conclude your report with `DECISION: MERGE` ONLY if all automated checks passed AND your line-by-line review confirms the code is robust and bug-free.'
      : '  - Conclude your report with `DECISION: APPROVE` if all tests passed and the code is clean (human maintainer will merge).',
    '  - Conclude your report with `DECISION: REQUEST_CHANGES` if tests failed, or if you found bugs, flaws, or missing tests.',
    `  - Conclude your report with \`DECISION: CLOSE\` if the ${words.request} is spam, malicious, completely misguided, or unfixable.`,
    '',
    ...standing.filter(Boolean).flatMap(rule => ['', rule]),
    ...instructions.trim() ? ['', '## Team instructions', '', instructions.trim()] : [],
    reportInstructions(),
  ].join('\n')
}

/** Composes the prompt for one ticket: who asked, what they asked, and what the agent must not assume. */
export function composePrompt(input: PromptInput): string {
  if (input.isPrReview && input.prNumber) {
    return composePrReviewPrompt(input)
  }
  const { ticket, trigger, repository, agentLogin, branchPrefix, instructions, source = 'github', branch, standing = [], notes = [] } = input
  const words = forgeWords(source)
  const asked = trigger
    ? `A person wrote this in ${trigger.url ?? trigger.channel?.thread ?? 'the source conversation'}:\n\n${quote(trigger.text)}`
    : `The ticket has no source message; work on the title alone:\n\n${quote(ticket.title)}`
  return [
    `# Ticket ${ticket.id}`,
    '',
    ...source === 'feishu'
      ? [`You work on the repository \`${repository}\`. The request came from a chat, which has no branch of its own, so open your`,
        `${words.request} from a new branch and say in your report where the person can find it.`]
      : [`You work on the repository \`${repository}\`. Your ${words.name} account is \`${agentLogin}\`; every ${words.name} action you take is`,
        'visible to the team under that name.'],
    '',
    '## The request',
    '',
    asked,
    ...notes.filter(Boolean).flatMap(note => ['', '## Notes since the start', '', quote(note)]),
    '',
    '## How to work',
    '',
    `- Work only in this directory. It is a worktree of the repository on a new branch.`,
    branch
      ? `- Commit on the branch \`${branch}\`, which this directory is already on, and open a ${words.request} from it when done.`
      : `- Put your branch under \`${branchPrefix}\` followed by a short name, and open a ${words.request} from it when done.`,
    '- Run the tests the repository has. Do not claim a check passed unless you ran it.',
    `- Do not merge the ${words.request}. A person merges it.`,
    '- If the request needs a decision you cannot make, stop and ask one concrete question.',
    ...input.readOnly ? [
      '- Autonomous run mode: you may inspect, search, and run tests, but do NOT push commits or make permanent mutations.',
      '- If code changes or human decisions are required, report state as "blocked" and provide a "question" for human approval.',
    ] : [],
    ...standing.filter(Boolean).flatMap(rule => ['', rule]),
    ...instructions.trim() ? ['', '## Team instructions', '', instructions.trim()] : [],
    reportInstructions(),
  ].join('\n')
}

/** Indents a person's message so the agent reads it as quoted material, not as instructions to this prompt. */
function quote(text: string): string {
  const body = text.trim() || '(empty message)'
  return body.split('\n').map(line => `> ${line}`).join('\n')
}
