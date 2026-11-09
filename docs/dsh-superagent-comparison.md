# superagent and dsh-superagent: a feature comparison

This document compares this project (`superagent`, the npm package `superagent-skill`) with `dsh-superagent`, the
earlier research prototype in `/Users/smallnest/dsh-superagent`. It states what each project does today, and why they
differ. The source of each claim is named, so a reader can check it. A Chinese version is in
[`dsh-superagent-comparison.zh.md`](dsh-superagent-comparison.zh.md).

## Summary

`dsh-superagent` is a plugin for the DeepSeek Harness (DSH). It runs inside a DSH profile with a panel, a management
API and a SQLite store. It uses several agent roles: an orchestrator decides, and a worker does each ticket. It has a
wide operator surface.

`superagent` is a standalone Node program that a person installs with npm. It runs a round loop from the command line,
keeps its state in plain JSON files, and gives each ticket to one coding agent CLI (Claude Code, Codex or opencode).
It keeps the same ideas: Triggers, Evals, Decisions, Tickets with Mandates, admission rules and observe mode. It drops
the multi-role prompts and the panel.

Rule of thumb: use `dsh-superagent` when you need the panel, the database, handback between workers, or prompt
editing by a team. Use `superagent` when you need a small tool that starts with one command and can be read from the
file system.

## What stays the same

Both projects implement the model that `docs/001-domain.md` in `dsh-superagent` describes:

- A Source turns a message into a **Trigger** on a **Thread**.
- An **Eval** judges the Trigger: a deterministic gate, then a model assessment.
- A **Decision** follows. An accept creates a **Ticket** with a **Mandate** that records who asked and why.
- An **Assignment** runs the ticket on an executor. A **Report** comes back, and the conversation gets a reply.
- Admission has two strengths: `explicit` (a listed person addressed the agent) and `inferred` (an unaddressed message
  that an assessment matches to an enabled rule).
- `eval.mode` (here `policy.mode`) has `off`, `observe` and `auto`. The default is `observe`.
- Any inferred accept needs a matching enabled rule. Every enabled rule gets exactly one verdict.
- A source scope limits where an installation listens at all.

## Deployment and runtime

| | dsh-superagent | superagent |
| --- | --- | --- |
| Form | A DSH bundle: a plugin inside a DSH profile | A standalone Node CLI (`superagent`), installed from npm |
| Install | `npm i -g @deepseek-ai/dsh`, `pnpm build`, create a profile, `dsh plugin add link:$PWD` | `npm install -g superagent-skill`, `superagent init <dir>` |
| Prerequisites | Node 22.19+, pnpm, git 2.32+, Python, tmux, gh, optional lark-cli, a DSH version in the `engines.dsh` range | Node 22.19+, git, gh, optional lark-cli, one coding agent CLI |
| Process | `dsh --profile <p>` in tmux, managed by `scripts/dsh-superagent start|stop|restart|status` | `superagent poll <dir>`; the operator runs it directly or from cron |
| Operator surface | Panel (`127.0.0.1:3082/orchestrator/api`), management API, status script with exit codes 0/1/2/3 | `superagent init`, `status`, `doctor`, `agents`, `run -p`, `poll [--once]` |
| Scheduling | External hourly check calls the status script; a restart needs `--respect-stop` | A cron line or a timer runs `poll --once`, one round per call |

## Sources

| | dsh-superagent | superagent |
| --- | --- | --- |
| GitHub | Notifications poll, plus the PRs and CI of open tickets, plus subscribed threads. Receive-all switches: `observeIssues`, `observePulls`, `observeComments`, `observeCi` | Notifications poll only. Mentions on the configured repository from a listed login |
| Feishu | Long-connection consumer, history backfill, chat-name refresh, topic polling. Per chat: `listen: mentions \| all`, `otherChats` | Long-connection consumer. Per chat: listened and observed. `directMessages`, `syncChat` |
| Source scope | The admission table has a row per receiving place (each chat, `other`, `direct`; issues, pulls, comments, CI) | A chat the bot is in is observed as a whole; GitHub is listened to for the configured repository only |
| Enterprise | GitHub Enterprise Server is not supported | Same limitation |

## Who may ask for work

| | dsh-superagent | superagent |
| --- | --- | --- |
| Allow lists | Per Source, plus bot lists. A bot can only produce an inferred candidate | Per Source (`github.allowed`, `feishu.allowed`), and `syncChat` copies a chat's members. A non-human message gets `bot` and stops at the gate |
| Listed, addressed | `explicit` | `explicit` |
| Listed, unaddressed | `inferred` by default (`listedUnaddressed`) | `inferred` when the Source observes the message |
| Unlisted, addressed | Configurable per table cell; `ignore` by default | `notAllowed`; there is no table |
| Unlisted, unaddressed | Configurable per table cell; `ignore` by default | Not admitted |
| Rules | Rules with an id, name, enabled flag and instruction, edited in the panel | The same, in `settings.yaml` under `policy.rules`. They are read on every gate, so an edit applies to the next message |
| Assessor | The main Session, with the orchestrator prompts and a 14-tool preset | One `claude -p` call that prints JSON; no tools, no work |
| Eval timeout | 120 s, two retries, then `unavailable` | 120 s, two requeues, then `unavailable` |

What is lost here: the admission table. An installation cannot admit an unlisted person's message, and it cannot
treat a bot's message as a candidate. The table is the DSH feature that this project does not model.

## Agent roles and prompts

| | dsh-superagent | superagent |
| --- | --- | --- |
| Roles | Orchestrator (main Session) and worker (one Session per ticket), with separate presets and tool sets | One role: the executor. The agent runs as a CLI subprocess for one ticket |
| Prompt files | `prompts/` with 438 lines across orchestrator, shared, subscriptions, replies, dispatch, admission, handoff and team sections, versioned and editable in the panel | Two standing files (`prompts/scope.md`, `prompts/delivery.md`), plus the request and the report contract that the code composes |
| Model choice | `eval.model` and `executor.model`, per role | `executor.agent` (`claude`, `codex`, `opencode`), `executor.model` |
| Prompt change | In the panel, with history and a diff; the next ticket uses it | Edit the files; they are read on every round |
| Follow-ups | The worker owns messages on its own threads; an out-of-scope message goes back to the main Session (`handback`) and is evaluated again | A human message on a ticket's thread becomes an Input. There is no handback |

The DSH roles exist because an orchestrator decides with many tools and a worker works in one Session. In this
project the round loop decides, and the coding agent does the work. The prompts that remain are the rules that
survived the move: scope and delivery.

## Execution

| | dsh-superagent | superagent |
| --- | --- | --- |
| Workspace | A per-ticket directory from `<stateDir>/work/<name>`; the operator supplies a `prepare` command, such as `git worktree add` | A git worktree per ticket at `<stateDir>/work/<ticketId>`, on a branch named from the title. The code creates it |
| Isolation | The operator's OS user, `danger-full-access`; the docs say to use a separate OS account | The operator's user, with `worker-bin` shims for `gh` and `lark-cli`, an optional `blockedCommands` list, and a prepared git config |
| Turn cap | 30 min per turn after the turn ends, with background jobs | `executor.timeoutMinutes` (default 60) |
| Concurrency | `executor.maxWorkers` (default 3), plus a slot for people | `executor.maxWorkers` (default 1); the tickets over the limit wait and start as a turn ends |
| Reports | `progress`, `waiting`, `ready`, `blocked`, `failed`, `dropped`; PRs bind with a tool | `ready`, `blocked`, `failed`, in `.superagent/report.json`; a turn log goes to `.superagent/log.md` |
| Questions | A structured `human_action`, relayed as an `attention` reply | A `question` field on a `blocked` report |
| Stop and retry | Panel or a person's message; retry runs a new Assignment in the same Session | `stopTicket` and `retryTicket` exist in the Engine; the CLI does not expose them yet |
| Merge | Auto-merge is prompt-governed and opt-in | The prompt says a person merges |

## Replies to conversations

| | dsh-superagent | superagent |
| --- | --- | --- |
| Purposes | `result`, `attention`, `answer`, `acknowledgement` | The same four, with the same rules in `src/core/replies.ts` |
| Length | 100 words maximum, hard reject | The first sentence, cut at 200 characters |
| GitHub prefix | Every message starts with "This is by an automated agent, not a human" | Not implemented |
| Idempotency | Receipts in the store; a dropped message is never resent | An outbox keyed by purpose and trigger, flushed each round |

## State and recovery

| | dsh-superagent | superagent |
| --- | --- | --- |
| Store | One SQLite file, `<stateDir>/orchestrator.sqlite`, with a directory lock and a durable effect queue | One JSON file per object under `stateDir/`, written with a temporary file and a rename, in transactions |
| Read by hand | Not practical without a query tool | `ls` and `cat` answer "what is open" |
| Restart | Running Assignments end as "host restarted" and restart oldest first with a recovery note; Sessions survive | On start, the loop marks each assignment left running as interrupted and restarts it with a recovery note in its prompt; the turn starts over, since the agent runs as a process |
| Retention | Rows are never deleted; tables grow without bound | Files stay until a person removes them |

## Operator experience

| | dsh-superagent | superagent |
| --- | --- | --- |
| Health | A health entry per component (runtime, models, evals, launch, delivery, replies, each Source). `status` exits 0, 1, 2 or 3 | No health check. `status` prints Markdown; `doctor` checks which agent CLIs are installed |
| Setup checks | Probes the CLIs, checks push access, writes the shims, refuses foreign files | `superagent doctor` only checks that the CLIs are installed |
| Unaddressed-message review | Panel tabs for Source, Trigger, Eval and Execution | `superagent status` lists the last ten inferred decisions, including observe would-accepts |
| Tests | 60+ Vitest specs, including panel and simulated-host tests, and `pnpm check` | 44 Vitest tests, including a full round on a stand-in `gh` and `lark-cli`, and `pnpm check` |
| CI | None in the repository | None in the repository |

## Where this project is behind

- **Admission table:** no per-row admission for unlisted senders.
- **Follow-ups and handback:** a worker cannot hand a message back for a new decision.
- **Panel and API:** no UI, no management API, no health entries per component.
- **Retry and stop from the CLI:** the Engine has them; the command does not.
- **Sessions:** a turn starts over after a restart. An agent CLI has no session to resume, so the recovery note tells it to
  inspect the worktree and git history first.
- **GitHub PR and CI tracking:** the agent opens pull requests, but the loop does not follow their checks.

## Where this project is ahead or simpler

- **One install:** npm, then `superagent init`. A DSH install needs DSH, a profile, a plugin link, tmux and Python.
- **Readable state:** a person can read the whole state directory.
- **Assessor isolation:** the assessor is one read-only model call. The DSH admission prompt runs in the same Session
  that dispatches work.
- **Correction from the field:** each observed case added directly to this code and its tests, such as a Feishu
  message that arrives mid-round, or a report that comes back from a turn.

## Known issues

- **Feishu push:** on the machine this document was written on, `lark-cli event consume` received no event for a
  message a person sent in the chat, while the bot's own messages in the same chat were readable with
  `im +messages-search`. The cause is unconfirmed. The Feishu path is proven with a stand-in CLI and once against a
  real bot for a mention.
- **Assessor cost:** each unaddressed message is one `claude -p` call, in observe mode too. A chat with much talk
  costs model calls.
