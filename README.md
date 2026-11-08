# superagent

An agent that turns requests from GitHub and Feishu into tickets, and runs each ticket on the coding agent you choose.

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
$EDITOR settings.yaml       # set github.repository, executor.agent, allowed lists
superagent doctor           # confirms the chosen agent is installed
superagent run . -p "Read README.md and summarise it in one sentence."
superagent status
```

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

## Status

Done and tested: the domain, file-backed state, the settings file, three agent runners (verified against the real CLIs),
the GitHub notification poller, the Feishu Source, worktree creation per ticket, the round loop, and delivery of the
agent's report back to the conversation. The Feishu path is proven with a stand-in `lark-cli` and once end to end
against a real Feishu bot.

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

Start the loop from that directory: `superagent poll` keeps running, and `superagent poll --once` runs one round, which
is what a cron entry calls each minute.

`checkout` names the repository the tickets change, and `executor.agent` names the coding agent. Both `github` and
`feishu` are optional, but at least one must be on.

## Tests

```sh
pnpm check                                     # typecheck, unit tests, build
SUPERAGENT_LIVE=1 SUPERAGENT_AGENT=codex pnpm test   # also runs a real agent end to end
```
