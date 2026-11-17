<!-- reviewed-through: 969e797 (2026-11-15) -->
# Lessons from this repository's work

superagent is a small repository where agents write most of the code. Most of
what goes wrong here has already gone wrong once: a setting that was shipped
but read nowhere, a note written after the worker that needed it had started, a
doc line that claimed a test nobody ran. This file keeps those occasions as
rules — the rule, why it holds, and the commit, test or run that showed it.

Read this before changing code. Add to it before you finish.

## How to use this file

- A lesson is a rule someone can follow, then the thing that taught it. The
  evidence keeps the rule from drifting into general advice.
- `Seen N×` counts separate tasks, not repetitions of one incident. A rule seen
  three times moves into [AGENTS.md](AGENTS.md), so its check runs where the
  work already runs.
- Add a lesson when a task needed a second pass, a test went red for a reason
  no test named, a review found a hole the author had missed, or a commit or
  doc claimed more than was run.
- Do not add general good practice ("write tests", "keep functions small").
  Only what this repository paid for.
- Every task ends with one of three things in its commit body: a new lesson, a
  raised `Seen`, or `No new lesson: <reason>`.
- When you review a stretch of commits, move the `reviewed-through:` marker at
  the top to the last commit you read.

## Read what you were given

**A setting is wired and proven before it ships.**
- `01cdaf7`: `executor.maxWorkers` sat in the settings schema and did nothing,
  so a burst of accepted messages started one agent per message. The fix added
  a queue and a test that starts two tickets with `maxWorkers: 1` and checks
  the second turn starts only when the first ends (`tests/poll.test.ts`).
- A settings test that parses the number proves the parser, not the limit.
  Read the value where the work consumes it, and test that place.
- Seen 1× (2026-11-09).

**One setting has one schema.**
- `src/settings.ts:23` defaults `maxWorkers` to 1 and is what every command
  reads. `src/core/policy.ts:93` also carried an `ExecutorConfigSchema`
  defaulting to 3, imported by nothing. A reader who picked the wrong copy
  changed behaviour silently.
- The copy was not one field: `policy`, `eval`, `executor` and `sources` were
  all rebuilt beside the live schema, and the two modules it alone imported
  (`src/core/limits.ts`, `src/core/admission.ts`) existed only for it. All of
  it went on 2026-11-17; `src/core/policy.ts` keeps the assessment schemas
  `src/assess.ts` uses and nothing else.
- When a setting moves, delete the old copy and whatever only it uses in the
  same commit. A schema nothing imports is not documentation; its defaults are
  a second answer.
- Seen 2× (2026-11-17).

**A test that is documented is the test that ran.**
- `08ba7ca` wrote "the Feishu path was tested from Feishu" into the README.
  What happened was one live run through a real bot, not a test; `9dff1d1`
  rewrote the line to say exactly that.
- Write the run: what was started, against which account, on what date. When
  there was no run, say "not tested".
- Seen 1× (2026-11-08).

**External ids and event keys are read from the CLI or the API, never
guessed from the docs.**
- `6692d0d`: the Feishu event key was not the one the bot's app subscribes to,
  so no message arrived. `8130f82`: the bot's open id was read from somewhere
  other than the listened chats. `ec6afe5` then read it once per run instead of
  per message.
- `gh` and `lark-cli` already know the answer; `superagent setup` exists so a
  person does not copy ids from a web page (README, "Use").
- A guess here passes every unit test and fails only with a real account.
- Seen 1× (2026-11-08).

## Order of what runs

**Anything the work must read is in place before the call that starts it.**
- `01cdaf7`: `Tickets.restart` wrote the recovery note after the new
  assignment had been dispatched, so the worker never received it. The note now
  joins the inputs before dispatch, and the turned-over assignment is stopped.
- The same commit gave a fresh turn no session to read a note in, so the note
  became a prompt input under "Notes since the start" and every turn's log
  keeps its prompt.
- A write after the start is a race with the reader, not a second step.
- Seen 1× (2026-11-09).

**Pass an optional argument where the decision is made, not after a spread.**
- `a9ed1d7`: `site` was passed after an optional spread, so it landed only in
  the spread's true branch. A turn's report was never recorded when Feishu was
  off — the one configuration the tests did not run.
- Build the call's arguments in one place, or set the value in both branches.
  Then run the test with the optional absent.
- Seen 1× (2026-11-09).

**A shared log is appended to; it is never read back and rewritten.**
- `01cdaf7`: a turn log rewrote the file after reading it, so two turns of one
  ticket could lose an entry. It now appends one entry per turn
  (`src/runner.ts:379`).
- A stream can end several turns of one ticket at once; the file is written by
  whichever turn finishes, in any order.
- Seen 1× (2026-11-09).

**A library does not end the process that embeds it.**
- `01cdaf7`: a single round called `process.exit`, and VITEST embeds the loop
  in the test process, so a test would have taken the suite down with it.
- The exit now sits in one gated place (`src/runner.ts:728`) and `bin/` owns
  the real process. A new entry point that ends a round inherits both rules.
- Seen 1× (2026-11-09).

**A ticket owns its worktree.**
- `339603c` raised `maxWorkers` to 5 because each ticket already had its own
  worktree, branch and directory. Nothing is shared between tickets except the
  state files, which are written per ticket.
- Raising a concurrency limit is only safe after naming what the workers share.
  Here: the executor queue, the state files and the delivery Source.
- Seen 1× (2026-11-08).

**A restart continues the ticket; it does not make a new one.**
- `01cdaf7`: a ticket whose agent died with the process stayed `running`
  forever, because no turn came back to report. At start, the loop now hands
  every active ticket on disk to the executor, which marks the left-running
  assignment interrupted and restarts it through the Engine in the same queue.
- Disk state is the truth. An in-memory flag cannot survive the crash that
  makes recovery necessary.
- Seen 1× (2026-11-09).

## Verification

**A test that starts a real agent is opt-in, and says what it costs.**
- `tests/agents.live.test.ts` runs only with `SUPERAGENT_LIVE=1`, because it
  starts a real agent and spends tokens. The default suite stays offline.
- A change that needs a real CLI is proven by a live run recorded in the commit
  body, with the opt-in test as the repeatable part.
- Seen 1× (2026-11-08).

**Text cut for a person is tested with the strings that must survive.**
- `6990b3e`: the reply became the report's first sentence, cut at 200
  characters. `deliverable()` splits English at ". " and Chinese at its own
  punctuation so `zod 4.4.3` and `README.md` stay whole.
- Test the values a naive split breaks — a decimal, a filename, an id — not
  only a plain sentence.
- Seen 1× (2026-11-08).

**A prompt is a file in `prompts/`, and a test proves it reaches the agent.**
- `816a475`: the two DSH rules that still apply to a one-process ticket
  (keep the change to what was asked; describe and reconcile the pull request)
  live as text in `prompts/`, so they are editable without a build and ship
  with the package.
- `tests/prompts.test.ts` proves the composed prompt carries them, the
  operator's instructions and the report contract. Editing a prompt without
  that test is editing an invisible input.
- Seen 1× (2026-11-08).

**A red in a full run is compared against the base before it is blamed on the
change.**
- 2026-11-17: the full suite left `tests/poll.test.ts` red ("the agent run is
  recorded beside its worktree" — the log was empty) and once timed out
  `tests/pr-review.test.ts`. Both pass run alone, and a clean worktree at
  `969e797` fails `poll.test.ts` the same way in a full run, so neither
  belonged to the change being verified.
- Run the failing file alone, then run it at the base in a separate worktree
  (`git worktree add <dir> HEAD`). A red that predates the change is reported
  with both runs; it is not folded into the commit as a known flake.
- Seen 1× (2026-11-17).

## Packaging and releases

**Build at pack time, not at install time.**
- `c21c2af`: npm 11 refuses an install script a package did not get approved
  for, and `lib/` ships inside the tarball. The build moved from `prepare`
  (runs on install) to `prepack` (runs on pack).
- Test a release by installing the tarball into an empty directory, not by
  running the checkout's bin.
- Seen 1× (2026-11-08).

**The npm name and the bin name are different decisions.**
- `d705447`: npm's `superagent` was taken, so the package is
  `superagent-skill` and the command stays `superagent`. README installs with
  `npm install -g superagent-skill`.
- A rename touches three things: `package.json` name, the `bin` key and the
  install line in every doc.
- Seen 1× (2026-11-08).

**A version bump exists to make the published artifact match the code.**
- `c89395a` (0.2.0) was not about features; it made the tarball carry the code
  that had already merged — proactive claiming, a real `maxWorkers` limit and
  recovery of interrupted tickets.
- A release body says what the tarball now holds that the last one did not.
- Seen 1× (2026-11-09).

**A publish appears in the registry only after npm has finished processing it.**
- 2026-11-17: `npm publish` printed `+ superagent-skill@0.4.1`, and for the next
  ~1.5 minutes the registry still served 0.4.0 and answered 404 for 0.4.1. A
  second publish was started on that reading; the first had already been
  accepted, and `time.modified` moved once processing finished.
- Verify against the packument — `curl https://registry.npmjs.org/<name>` and
  read `versions` and `dist-tags` — not `npm view <name>@<version>` seconds
  after the upload. A second publish of the same version fails, so wait for the
  first instead of resending it.
- Seen 1× (2026-11-17).

**A credential in `~/.npmrc` is checked with `npm whoami` before it is trusted.**
- 2026-11-17: `npm whoami` returned 401 in this checkout while `$NPM_TOKEN`
  authenticated as `smallnest`; the `_authToken` line in `~/.npmrc` was stale.
  Publishing with `--//registry.npmjs.org/:_authToken="$NPM_TOKEN"` worked.
- Ask npm which identity it resolved rather than trusting the file, and never
  put the token in a log or a commit.
- Seen 1× (2026-11-17).
