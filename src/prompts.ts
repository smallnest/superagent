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
  /** The Source the request came from; a Feishu chat has no GitHub account to open a pull request from. */
  source?: 'github' | 'feishu'
  /** The branch the worktree was created on, which the agent pushes instead of naming one itself. */
  branch?: string
  /** The standing rules, from `standingRules`. */
  standing?: string[]
  /** Notes a person was sent, such as a recovery note after a restart, which a fresh turn has not read in a session. */
  notes?: string[]
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

/** Composes the prompt for one ticket: who asked, what they asked, and what the agent must not assume. */
export function composePrompt(input: PromptInput): string {
  const { ticket, trigger, repository, agentLogin, branchPrefix, instructions, source = 'github', branch, standing = [], notes = [] } = input
  const asked = trigger
    ? `A person wrote this in ${trigger.url ?? trigger.channel?.thread ?? 'the source conversation'}:\n\n${quote(trigger.text)}`
    : `The ticket has no source message; work on the title alone:\n\n${quote(ticket.title)}`
  return [
    `# Ticket ${ticket.id}`,
    '',
    ...source === 'feishu'
      ? [`You work on the repository \`${repository}\`. The request came from a chat, which has no branch of its own, so open your`,
        'pull request from a new branch and say in your report where the person can find it.']
      : [`You work on the repository \`${repository}\`. Your GitHub account is \`${agentLogin}\`; every GitHub action you take is`,
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
      ? `- Commit on the branch \`${branch}\`, which this directory is already on, and open a pull request from it when done.`
      : `- Put your branch under \`${branchPrefix}\` followed by a short name, and open a pull request from it when done.`,
    '- Run the tests the repository has. Do not claim a check passed unless you ran it.',
    '- Do not merge the pull request. A person merges it.',
    '- If the request needs a decision you cannot make, stop and ask one concrete question.',
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
