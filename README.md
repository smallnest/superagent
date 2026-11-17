# superagent

An agent that turns requests from GitHub, GitLab, Feishu, and Twitter/X into tickets, and runs each ticket on the coding agent you choose.

- **No web panel.** State is JSON files under `stateDir`, so `ls` and `cat` answer what a dashboard would.
- **No vendor lock-in.** The executor is a configuration value: `claude`, `codex` or `opencode`, behind one interface.
- **No daemon.** Every command is a short-lived process; a cron job or a coding agent can drive it.

## Install

```sh
pnpm install && pnpm build
# put `bin/superagent.js` on PATH, or link it:
ln -sf "$PWD/bin/superagent.js" ~/.local/bin/superagent
```

## Use

```sh
mkdir my-agent && cd my-agent
superagent init             # writes settings.yaml and state/
superagent setup            # reads the GitHub account and the Feishu chat from `gh` and `lark-cli`
$EDITOR settings.yaml       # choose executor.agent; adjust what setup filled
superagent doctor           # confirms the chosen agent is installed
superagent run . -p "Read README.md and summarise it in one sentence."
superagent status
```

`superagent setup` asks the CLIs that already know the answers, so no id is copied from a web page:

```sh
superagent setup .                     # the forge in settings.yaml and Feishu, from the CLIs
superagent setup . github              # only the GitHub section
superagent setup . gitlab              # only the GitLab section
superagent setup . feishu --chat Team  # the chat by name instead of id
superagent setup . --allow alice,bob   # who may ask; a Feishu user name becomes an open id
```

It writes the login `gh` acts as, proves the repository is readable, lists the bot's chats, sets `feishu.syncChat` so
the chat's members may ask, and turns each `--allow` name into the member's open id. It keeps every other line of
`settings.yaml`. A CLI that cannot answer leaves that section as it was and exits with 1.

`superagent run` is the smallest end-to-end test: it starts the configured agent in the current directory, waits for the
turn to end, and prints the report the agent left in `.superagent/report.json`.

## How a ticket runs

1. A Source receives a message a person addressed to the agent, from an account on the allow list.
2. The engine records a Trigger, assesses it, and either accepts it as a **ticket** or ignores it with a reason.
3. The executor prepares a worktree and starts the configured agent in it with the composed prompt.
4. The agent works, and writes `.superagent/report.json` before it stops.
5. The report is delivered back to the conversation the request came from.

## The agent contract

Every runner satisfies the same three conditions, which is what makes agents interchangeable:

| Condition | Why |
| --- | --- |
| Starts in the ticket's directory | The worktree, not the operator's checkout, is what changes |
| Reads one prompt on stdin, ends the turn | No interactive step a runner must drive |
| Writes `.superagent/report.json` | One file to read, identical for every agent |

Adding an agent is one file in `src/agents/` plus one line in the registry.

## Layout

```
src/core/      domain: triggers, decisions, tickets, assignments, engine
src/state/     file-backed durable state
src/agents/    one runner per coding agent
src/infra/     CLI wrappers, account shims, git configuration
src/settings.ts  the settings schema and a small YAML reader
```

## Polling

```sh
superagent poll .          # one round every github.pollSeconds until interrupted
superagent poll . --once   # one round, for a cron job or a test
```

A round reads the agent account's GitHub notifications, keeps the ones for `github.repository` from a login on
`github.allowed`, builds a Trigger for each mention, and accepts it as a ticket. The ticket runs on
`executor.agent`; its report is written under `stateDir/work/<ticket>/.superagent/log.md`.

A message in a chat the bot reads that names no one is assessed by one `claude -p` call per message, against the
`policy.rules` in `settings.yaml`. In `observe` mode the verdict is recorded and no ticket starts; `auto` accepts the
ones the assessor matches. `superagent status` lists the recent judgements.

Arbitrary polling is not yet wired, so a person runs `poll` under cron or a systemd timer:

```cron
*/1 * * * * cd /path/to/install && superagent poll . --once >> state/poll.log 2>&1
```

## GitLab, including a self-managed instance

A GitLab installation reads the agent account's pending *to-do items* — a mention, a direct address, an assignment or a
review request — and, when review is on, the project's open merge requests. The report goes back as a note on the issue
or merge request, and a review can squash-merge the merge request once verification and the review both pass.

```yaml
gitlab:
  host: gitlab.example.com     # gitlab.com by default; a port is allowed for a self-managed instance
  project: group/sub/project   # the project path, subgroups included
  cli: glab-agent              # the CLI that acts as the agent's account; `glab auth login --hostname <host>`
  pollSeconds: 60
  allowed: [alice, bob]        # GitLab usernames that may ask for work
  mrReview:
    enabled: true
    pollOpenMrs: true
    verifyCommands: ["npm test"]
    autoMerge: true
    squash: true               # GitLab applies its project setting when false
```

One installation serves one forge: `github.enabled` and `gitlab.enabled` cannot both be true, because the worker's git
credentials and CLI shim bind to one account. A merge request triggers the same review prompt as a pull request, with
GitLab's words and its `refs/merge-requests/<iid>/head` checkout.

## Compare with dsh-superagent

[`docs/dsh-superagent-comparison.md`](docs/dsh-superagent-comparison.md)（[中文版](docs/dsh-superagent-comparison.zh.md)）
compares this project with the earlier `dsh-superagent` DSH bundle: what both keep, what each does differently, and where
this one is behind.

## Always-on Agent Architecture

See [`docs/always-on-architecture.md`](docs/always-on-architecture.md)（[中文版](docs/always-on-architecture.zh.md)）
for how superagent incorporates the five core primitives from Anthropic's [*"Building always-on agents"*](https://claude.com/resources/articles/building-always-on-agents) (Event Inbox, Timers, Memory, Permissions, Outbox) and DeepSeek's Super-agent exploration: presence-aware attention routing, read-only autonomy, quiet hours batching, active watchers, and token budget protection.

## Status

Done and tested: the domain, file-backed state, the settings file, three agent runners (verified against the real CLIs),
the GitHub notification poller, the GitLab Source (to-dos, merge request review and merge), the Feishu Source, worktree
creation per ticket, the round loop, and delivery of the agent's report back to the conversation. The Feishu path is
proven with a stand-in `lark-cli` and once end to end against a real Feishu bot; the GitLab path is proven with a
stand-in `glab` and on GitLab 19.4.3 (`gitlab.sitinai.com`): an issue to-do became a ticket and a note, and a merge
request was reviewed, squash-merged and answered.

## Install once

```sh
npm install -g superagent-skill
superagent init ~/my-superagent && cd ~/my-superagent
superagent doctor
```

From a checkout instead, build it and link it yourself:

```sh
pnpm install && pnpm build
ln -sf "$PWD/bin/superagent.js" ~/.local/bin/superagent   # a directory on PATH
```

Start the loop from that directory: `superagent poll` keeps running, and `superagent poll . --once` runs one round,
waits for the turns it started, posts their reports, and exits — which is what a cron entry calls each minute.

`checkout` names the repository the tickets change, and `executor.agent` names the coding agent. The Sources are
optional, but at least one must be on; `github` and `gitlab` cannot both be, because one installation serves one forge.

## Tests

```sh
pnpm check                                     # typecheck, unit tests, build
SUPERAGENT_LIVE=1 SUPERAGENT_AGENT=codex pnpm test   # also runs a real agent end to end
```

## Lessons

[`LESSONS.md`](LESSONS.md) keeps what already cost a second pass here — a
setting shipped but read nowhere, a note written after the worker that needed
it started, a doc line that claimed a test nobody ran — as rules with the
commit or test that taught them. Read it before changing code; every task ends
by adding a lesson, raising one's `Seen` count, or saying why it taught
nothing.
