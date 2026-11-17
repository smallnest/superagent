<!-- reviewed-through: 969e797 (2026-11-15) -->
# Lessons from this repository's work

superagent is a small repository where agents write most of the code. Most of
what goes wrong here has already gone wrong once: a setting shipped but read
nowhere, a note written after the worker that needed it started, a doc line that
claimed a test nobody ran. This file keeps those occasions as rules — the rule,
why it holds, and the commit, test or run that showed it.

Read this before changing code. Add to it before you finish.

## How to use this file

- A lesson is a rule someone can follow, then the thing that taught it. The
  evidence keeps the rule from drifting into general advice.
- `Seen N×` counts separate tasks. A rule seen three times moves into
  [AGENTS.md](AGENTS.md), so its check runs where the work already runs.
- Add a lesson when a task needed a second pass, a test went red for a reason no
  test named, or a commit or doc claimed more than was run. Not general advice.
- Every task ends with a new lesson, a raised `Seen`, or `No new lesson: <reason>`.
- Keep this file under about 220 lines: delete a rule that no longer holds,
  merge the ones that say the same thing, cut a story to its sentence.
- When you review a stretch of commits, move the `reviewed-through:` marker at
  the top to the last commit you read.

## Read what you were given

**A setting is wired and proven before it ships.**
- `01cdaf7`: `executor.maxWorkers` sat in the schema and did nothing, so a burst
  of accepted messages started one agent per message. The fix added a queue and
  a test that starts two tickets with `maxWorkers: 1` and checks the second turn
  starts only when the first ends (`tests/poll.test.ts`).
- A settings test that parses the number proves the parser, not the limit.
- Seen 1× (2026-11-09).

**One setting has one schema.**
- `src/settings.ts:23` defaults `maxWorkers` to 1 and is what every command
  reads; `src/core/policy.ts:93` also carried an `ExecutorConfigSchema`
  defaulting to 3, imported by nothing. A reader who picked the wrong copy
  changed behaviour silently.
- The copy was the whole `policy`/`eval`/`executor`/`sources` set, plus the two
  modules only it used (`src/core/limits.ts`, `src/core/admission.ts`). All of it
  went on 2026-11-17; `core/policy.ts` keeps only the assessment schemas.
- Delete the old copy and whatever only it uses in the same commit.
- Seen 2× (2026-11-17).

**A test that is documented is the test that ran.**
- `08ba7ca` wrote "the Feishu path was tested from Feishu"; it was one live run
  through a real bot, not a test, and `9dff1d1` rewrote it.
- Write the run — what, against which account, on what date — or say "not tested".
- Seen 1× (2026-11-08).

**External ids and event keys are read from the CLI or the API, never guessed.**
- `6692d0d`: the Feishu event key was not the one the app subscribes to, so no
  message arrived. `8130f82`: the bot's open id came from the wrong place;
  `ec6afe5` read it once per run instead of per message.
- `gh` and `lark-cli` know the answer; `superagent setup` exists so a person does
  not copy ids from a web page. A guess passes every unit test and fails live.
- Seen 1× (2026-11-08).

**A second forge is a second event shape, not a rename of the first.**
- 2026-11-17: GitLab's `/todos` carries the note, its author and the issue or
  merge request's iid in one response; GitHub's notification needs a second call
  for the comment. The review head differs too: `refs/merge-requests/<iid>/head`
  against `pull/<n>/head`.
- Read the new forge's own event and name its pieces in `meta`.
- Seen 1× (2026-11-17).

**One rule with two homes is enforced by the schema, not the docs.**
- 2026-11-17: one installation serves one forge, because the worker's git
  credential helper and CLI shim bind to one account. `SettingsSchema` refuses
  both, so `init`, `setup` and a hand-edited file say the same thing.
- The check belongs where the value is parsed; README is read only by whoever
  reads it before the mistake.
- Seen 1× (2026-11-17).

**A schema default cannot be told from a value the operator wrote.**
- 2026-11-17: `gitlab.host` defaults to `gitlab.com`, so `setup gitlab` on a
  self-managed checkout kept `gitlab.com`. It now treats the default as unset and
  takes the origin when the host is still `gitlab.com`.
- When a step derives a value that has a default, prefer the stronger signal
  until a person writes something else.
- Seen 1× (2026-11-17).

## Order of what runs

**Anything the work must read is in place before the call that starts it.**
- `01cdaf7`: `Tickets.restart` wrote the recovery note after dispatch, so the
  worker never received it. The note now joins the inputs before dispatch.
- A write after the start is a race with the reader, not a second step.
- Seen 1× (2026-11-09).

**Pass an optional argument where the decision is made, not after a spread.**
- `a9ed1d7`: `site` was passed after an optional spread, so it landed only in the
  true branch; a turn's report was never recorded when Feishu was off.
- Build the arguments in one place, and run the test with the optional absent.
- Seen 1× (2026-11-09).

**A shared log is appended to; it is never read back and rewritten.**
- `01cdaf7`: a turn log rewrote the file after reading it, so two turns of one
  ticket could lose an entry. It appends one entry per turn (`run.ts:379`).
- Seen 1× (2026-11-09).

**A library does not end the process that embeds it.**
- `01cdaf7`: a single round called `process.exit`, and VITEST embeds the loop in
  the test process. The exit now sits in one gated place (`run.ts:728`).
- Seen 1× (2026-11-09).

**A restart continues the ticket; it does not make a new one.**
- `01cdaf7`: a ticket whose agent died stayed `running` forever. At start, the
  loop hands every active ticket on disk to the executor, which marks the
  left-running assignment interrupted and restarts it through the Engine.
- Disk state is the truth; an in-memory flag cannot survive the crash.
- Seen 1× (2026-11-09).

**A reply is posted once, in this process or the next.**
- 2026-11-17: `drain()` returned messages without consuming them and `send()`
  never withdrew a posted one, so a long-running `poll` posted the same report
  every interval; the live GitLab run showed it twice, 18 seconds apart.
- `send()` now withdraws after a successful post and records `outbox:<id>` in
  state; `outbox.send` refuses an id already sent. A failed post stays queued.
- Seen 2× (2026-11-17).

**A stand-in proves the shape; a live account proves the rounds.**
- 2026-11-17: the GitLab tests passed with a fake `glab`, and the live run still
  posted a note twice and left a turn half-run under `poll --once`.
- Keep the live round in the record, and run the process shape the operator uses.
- Seen 1× (2026-11-17).

**A one-round process finishes what it started.**
- 2026-11-17: `poll --once` exited while a review turn was fetching the head;
  every cron run restarted and killed it, so the work never finished.
- A run that asks to `finish` waits on `executor.idle()`, then delivers and posts.
  Live: one 10-second run merged MR !2 and posted both notes.
- The exit sits in one gated place and `bin/` owns the process: a library must
  not end the process that embeds it (`01cdaf7`, VITEST embeds the loop).
- Seen 1× (2026-11-17).

**A question the process exits before sending is never asked.**
- 2026-11-17: the workflow sent "要做吗" from `start` without awaiting it;
  `poll --once` aborted the run and killed the DM, so the ticket was held and the
  operator was never asked.
- The executor counts pending asks and `idle()` waits for them; answers too.
- Seen 1× (2026-11-17).

**A recovery path goes through the same gate as a new start.**
- 2026-11-17: `recover()` pushed a pending assignment straight into the queue, so
  a restart could start an unapproved issue or skip the gate. Both go through
  `dispatch`.
- When adding a gate, find every path that dispatches work.
- Seen 1× (2026-11-17).

**The queue's own choice is a person's act, not a bot message.**
- 2026-11-17: a proposed issue was ignored with reason `bot`: its author was the
  account the agent acts as, which is normal here (千寻 posts as `chaoyuepan`).
- `issueTrigger` now marks every non-bot issue human; the queue is the operator
  choosing.
- Seen 1× (2026-11-17).

**A queue follows the work's order, not the API's.**
- 2026-11-17: a `[Phase 0]`-first rule proposed `#2585` (newest). The issues are
  numbered in dependency order (`#2552`–`#2560` reference `#2548`–`#2551`;
  `#2585` references `#2557`), so ascending iid is the order.
- The label says what may be worked; the numbers say in what order.
- Seen 1× (2026-11-17).

**A long-lived branch is not a per-ticket worktree.**
- 2026-11-17: dora-service keeps one development branch ~600 commits from
  `release/test`. `executor.worktree: false` runs in that checkout; the test
  branch is a temporary branch from `release/test` with the issue cherry-picked.
- One branch, one issue at a time; only the state files are shared. A per-ticket
  branch would split the work, and a whole-branch merge would carry unrelated work.
- Seen 1× (2026-11-17).

## Verification

**A test that starts a real agent is opt-in, and says what it costs.**
- `tests/agents.live.test.ts` runs only with `SUPERAGENT_LIVE=1`.
- A change that needs a real CLI is proven by a live run in the commit body.
- Seen 1× (2026-11-08).

**Text cut for a person is tested with the strings that must survive.**
- `6990b3e`: the reply is the report's first sentence, cut at 200 characters;
  `deliverable()` keeps `zod 4.4.3` and `README.md` whole.
- Test a decimal, a filename, an id — not only a plain sentence.
- Seen 1× (2026-11-08).

**A prompt is a file in `prompts/`, and a test proves it reaches the agent.**
- `816a475`: the rules that apply to a one-process ticket live in `prompts/`, so
  they are editable without a build and ship with the package.
- `tests/prompts.test.ts` proves the composed prompt carries them.
- Seen 1× (2026-11-08).

**A red in a full run is compared against the base before it is blamed on the change.**
- 2026-11-17: the full suite left `poll.test.ts` red; it passed alone, and a
  clean worktree at `969e797` failed the same way. Run the file alone, then the
  base in a separate worktree, and report a red that predates the change.
- Seen 1× (2026-11-17).

**A test waits for the state it checks, not for a duration.**
- 2026-11-17: `poll.test.ts` slept 400/300 ms and lost the race in about half of
  the full runs. It now waits on the agent's start marker and the log entry.
- Pick the state the assertion needs, with a deadline longer than the work and
  shorter than the test's timeout.
- Seen 1× (2026-11-17).

**A test's own deadline fits inside the test's timeout.**
- 2026-11-17: `pr-review.test.ts` polled 10 s inside a test with no timeout, so
  vitest's 5 s default ended it first. It now asks for 30 s.
- Seen 1× (2026-11-17).

## Packaging and releases

**Build at pack time, not at install time.**
- `c21c2af`: npm 11 refuses an install script a package was not approved for,
  and `lib/` ships in the tarball. The build moved from `prepare` to `prepack`.
- Test a release by installing the tarball into an empty directory.
- Seen 1× (2026-11-08).

The publish checks — the registry's delay, and which credential works — are in
[AGENTS.md](AGENTS.md), under Publishing; they were seen three times and moved.

## Open work these lessons name

- A GitHub or Feishu live round after the outbox change: only GitLab has been run
  against a real account since.
- `poll --once` now outlives its interval when a turn is long, and the state
  directory has no lock, so cron runs can overlap. Until there is a lock, the
  interval must be longer than a turn, or the installation runs the long `poll`.
