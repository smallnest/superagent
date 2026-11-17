# Working in this repository

## Read `LESSONS.md` before changing code

[`LESSONS.md`](LESSONS.md) is the record of what already cost a second pass
here: a fix that followed a feature, a red test, a wrong claim in a doc, a
release that would not install. Read the rules that touch what you are about
to change, and follow them.

## Every task ends with a lesson

Before you finish a task — a fix, a feature, a refactor, a release — update
`LESSONS.md`:

- New thing learned: add a rule with why and evidence (commit sha, test name,
  or the run that showed it), and `Seen 1× (YYYY-MM-DD)`.
- Already there: raise its `Seen` count and add this task's evidence.
- Nothing learned: say so in the commit body as `No new lesson: <reason>`.
  An empty claim is worse than an honest one.

Write the rule as something a person can act on, not as a summary of the
change. Do not add general good practice; only what this repository paid for.
A rule seen three times moves into this file so its check runs where the work
does.

When a review covers a stretch of commits, move the `reviewed-through:` marker
at the top of `LESSONS.md` to the last commit read.

## Memory

`LESSONS.md` is the rulebook read before a change. Keep it under about 220
lines: delete a rule that no longer holds, merge the ones that say the same
thing, and cut a story back to its sentence. A rule seen three times moves into
this file.

The issue workflow also keeps a memory per installation: `记住 #<iid> <one
line>` in Feishu appends to `state/memory/rules.md`, which every ticket prompt
carries, capped by `workflow.memoryLines`. The bot sends the list back every
`workflow.reviewDays` so a person can delete what is wrong — an unreviewed rule
is followed more faithfully than any instruction typed later.

## Checks

- `pnpm check` — typecheck, unit tests, build. This is the default before a
  commit.
- `SUPERAGENT_LIVE=1 SUPERAGENT_AGENT=codex pnpm test` — also starts a real
  agent end to end. Costs tokens; run it when the change touches an agent
  runner or the prompt/report contract, and record the run in the commit body.

## Commits

Each commit says why the change exists. When tests or a live run proved it,
the body says what ran. When something was left untested, the body says that
too — the next reader decides whether it matters.

## Publishing

- Bump `package.json` in its own commit, push it, then publish from a clean
  tree.
- `npm publish` returning `+ name@version` is not proof it is live: the
  registry can answer 404 for that version for minutes (0.4.1 and 0.5.0 took
  ~1.5, 0.4.2 ~4.5). Verify against `https://registry.npmjs.org/<name>` —
  `versions` and `dist-tags`, or poll `/<name>/<version>`. Never resend the
  same version; the second publish fails and the first was already accepted.
- `npm whoami` decides which credential works. `~/.npmrc` may hold a stale
  token while `$NPM_TOKEN` is valid; publish with
  `--//registry.npmjs.org/:_authToken="$NPM_TOKEN"` when it is. Never put the
  token in a log or a commit.
- Install the published tarball into an empty directory and run its bin before
  calling it released.
