---
name: superagent
description: Run an agent that turns requests from GitHub issues or Feishu chats into tickets and executes each ticket on a configurable coding agent (Claude Code, Codex, opencode). Use when the user wants an agent to watch a repository or a chat, act on @ mentions, and record its work as plain files instead of a dashboard; when they ask what superagent has done, which tickets are open, or to change which coding agent runs tickets.
---

# Superagent

Superagent listens to GitHub and Feishu. A request that names the agent becomes a **ticket**. Each ticket runs on a
coding agent you choose, in its own worktree, and records itself as files on disk. When the agent reports it is done,
the summary goes back as a reply in the conversation that asked.

You operate an installation; you do not reimplement it. Read state with `superagent status` or by reading the files, and
change behaviour by editing `settings.yaml`.

## Look before acting

Run these from the installation directory — the one that holds `settings.yaml`:

```sh
superagent status          # open and ended tickets, as Markdown
superagent doctor          # which coding agents are installed, which one runs tickets
```

State is plain JSON under `stateDir`, so `ls` and `cat` answer more than the commands do:

| Path | Holds |
| --- | --- |
| `state/tickets/<id>/ticket.json` | one ticket: its mandate, assignments, attention and outcome |
| `state/tickets/<id>/log.md` | what the agent did for that ticket |
| `stateDir/work/<id>/.superagent/log.md` | the prompt, the agent's output and its report, kept beside the worktree |
| `state/threads/<key>.json` | one conversation, with the triggers waiting for an assessment |
| `state/decisions/<id>.json` | why a request was accepted or ignored |
| `state/triggers/<thread>/<at>-<id>.json` | every message a Source received |

## Choose the coding agent

`executor.agent` in `settings.yaml` names one of `claude`, `codex` or `opencode`. All three satisfy the same contract:

- The agent starts in the ticket's directory.
- It receives the composed prompt on standard input and stops at the end of the turn.
- It writes `.superagent/report.json` with at least `{"summary": "..."}`, and optionally `state`, `prs` and `question`.

Because the contract is a file and not a tool channel, adding an agent means one file in `src/agents/` that implements
`AgentRunner` and one line in `src/agents/index.ts`. Nothing else changes.

```yaml
executor:
  agent: codex        # claude | codex | opencode
  binary: codex       # optional; defaults to the agent name on PATH
  model: null         # passed as --model when set
  maxWorkers: 1       # tickets that may run at once
  timeoutMinutes: 60
```

Verify a choice before trusting it:

```sh
superagent doctor
superagent run . -p "Read README.md and summarise it in one sentence."
```

`run` starts the configured agent in the current directory and prints its report. That is the smallest end-to-end test
of an installation.

## Who may ask for work

Both Sources use an allow list. An empty list accepts nobody.

```yaml
github:
  repository: owner/name
  cli: gh-agent         # the CLI that acts as the agent's account
  allowed: [alice]      # GitHub logins
feishu:
  cli: lark-bot         # the CLI that acts as the bot
  chats: [{ chatId: oc_..., name: Team }]
  allowed: []           # or set syncChat to copy the chat's members
  syncChat: oc_...
```

The agent acts only as the accounts those CLIs are signed in to. Never point `cli` at a personal login: everything the
agent writes would appear under that person's name.

### Messages that do not address the agent

A message in a chat the bot reads that names no one is assessed, once per message, by one `claude -p` call that prints
a verdict. Turn this on in `settings.yaml`:

```yaml
policy:
  mode: observe        # off, observe, or auto
  rules:
    - id: unasked      # the rule that says the message asks for work at all
      name: Request
      instruction: The discussion asks for a concrete change to this project.
    - id: docs
      name: Documentation
      instruction: The change is to a document in the repository.
```

`observe` records what `auto` would accept and starts nothing; `auto` accepts the candidates the assessor matches. The
`unasked` rule is required for an unaddressed message to start work. `superagent status` lists the recent
judgements under "Unaddressed messages". Keep `observe` until the judgements read right.

## Rules to keep

- **Start narrow.** One repository, one chat, one allowed login. Widen after the agent's work looks right.
- **Tune for less noise.** When the agent is noisy, shorten the prompt or stop it. Do not add messages to explain noise.
- **Own what it says.** The agent writes under an account the team sees. Read what it posts and correct the prompt.

## Commands

| Command | Does |
| --- | --- |
| `superagent init [dir]` | create `settings.yaml` and the state directory; a second run keeps both |
| `superagent status [dir]` | print open and ended tickets, and the recent judgements of unaddressed messages, as Markdown |
| `superagent doctor [dir]` | show installed agents and the selected one |
| `superagent agents` | list the agent names a configuration may use |
| `superagent run [dir] -p <text>` | run one prompt on the configured agent and print its report |
| `superagent poll [dir] [--once]` | read GitHub notifications, accept mentions as tickets, and run them |

The first argument is the installation directory and defaults to the current directory.

## When something is wrong

| Symptom | Cause and fix |
| --- | --- |
| `No configuration at …` | Run `superagent init` in the installation directory. |
| `The configuration at … is invalid` | The message names the key; fix that key in `settings.yaml`. |
| `Selected: **x** — not installed` | Install that CLI or choose another `executor.agent`. |
| A ticket ends with a failed report | Read `state/tickets/<id>/log.md`; the agent's last message is at the end. |
| Nothing happens after a mention | Check the author is on the allow list and `enabled` is true for that Source. |

## Going further

`src/` holds the whole implementation:

- `src/core/` — the domain: triggers, decisions, tickets, assignments, and the engine that joins them. Pure TypeScript.
- `src/state/files.ts` — durable state as JSON files, with in-memory transactions.
- `src/agents/` — one file per coding agent, all behind `AgentRunner`.
- `src/infra/` — the CLI wrappers and the shims that bind a run to the agent's accounts.

Change a runner when an agent's output format changes; change the core only when the domain itself changes.
