# Always-On Superagent: Architectural Blueprint & Evolution Guide

> Drawing insights from Anthropic's official guide [*"Building always-on agents"*](https://claude.com/resources/articles/building-always-on-agents) (William Hu, Nov 13, 2026), DeepSeek Harness's *"Super-agent Design Exploration: Towards More Autonomous Agent Systems"*, and the FanBox engineering practice.

---

## 1. Core Alignment: "Always-On" is an Illusion; Human Attention is the Bottleneck

### 1. The Reality of Always-On Agents
As William Hu (Anthropic) articulates:
> **"Always-on agents aren't actually running continuously; that's just a user experience description. In reality, they spend most of their time asleep, consuming zero tokens. They wake up at intervals triggered by an event, do a discrete piece of work, persist what happened, and go back to sleep."**

This **Wake $\rightarrow$ Work $\rightarrow$ Write Back $\rightarrow$ Sleep** paradigm aligns identically with `superagent`'s foundational ethos:
- **No Heavy Background Daemons**: Ephemeral turns and poll cycles instead of brittle long-running server processes.
- **File-Backed Durable State**: Plain JSON/Markdown under `.superagent/` instead of complex database dependencies; inspectable with `ls` and `cat`.
- **Zero Vendor Lock-in**: Interchangeable runners for Claude Code, Codex, and OpenCode.

### 2. The Bottleneck: Human Attention Economy
As both DeepSeek Harness and Anthropic observed:
> *"The upper limit of a single task is model capability; the upper limit of multitasking is human attention."*
> *"Agents that send too much become noise; agents that send too little fail to inform. Start quiet, and earn human attention over time."*

A production-grade always-on agent must be disciplined, unobtrusive, secure, and cost-aware.

---

## 2. Mapping Anthropic's 5 Core Primitives to Superagent

| Primitive | Anthropic Definition & Challenges | Superagent Today | Target Evolution |
| :--- | :--- | :--- | :--- |
| **1. Event Inbox** | Decouple incoming triggers from execution. Prevent concurrency crashes; source deduplication; burst message coalescing. | Has GitHub notifications polling and Feishu streaming consumer; processed via `intake`. | **Unified Event Inbox**: Ingest GitHub, Feishu, Timers, and Watcher events into a unified queue. Add burst debouncing/coalescing for rapid sequential user messages. |
| **2. Timers** | Enable proactive behavior:<br>1) **Follow-ups**: Agent schedules its own future check (e.g. check CI in 20m).<br>2) **Schedules**: Periodic cron jobs (daily digest, health check). | Only static `pollSeconds` and stream idle timeout. **Lacks agent follow-ups and cron schedules.** | **Durable Timers Engine**: Store follow-ups and schedules in state. On deadline expiry, enqueue an event into the Inbox. |
| **3. Memory** | Durable cross-session state. Keep only what cannot be re-fetched; track "what was already told to the human" to prevent nagging. Prevent unvetted state from polluting long-term memory. | File-backed state (`ticket.json`, `log.md`, `decisions/`, `threads/`). Clean and transparent. | **Cognitive Memory & Notification Pointer**: Track communicated messages (prevent duplicate nagging); isolate long-term memory during unprompted runs. |
| **4. Permissions** | Mitigate high risks of unattended runs: credential proxying, action classifiers, deferred approval checkpoints. | Shims in `worker-bin` and `blockedCommands` list. Runs with full tool capability. | **Tiered Security Sandboxing**: Enforce "Read-only when unprompted" (`--tools Read,Grep,Glob`). Require human confirmation via `attention` before mutations. |
| **5. Outbox** | Reliable idempotent dispatch; start quiet; enforce IM bandwidth (≤ 100 words); presence-aware routing. | Outbox queue with idempotency; `deliverable()` cuts to first sentence (max 200 chars). | **Presence-Aware Attention Router**: Detect local keyboard/mouse activity. Keep quiet when at desk; push to mobile when away. Quiet hours (23:00-08:00) batching into morning digest. |

---

## 3. Four Practical Lessons & Engineering Solutions

### Lesson 1: "When Nobody Asked It, It May Only Look" (Read-Only Autonomy)
- **Problem**: When awakened autonomously by a timer, issue update, or unaddressed group chat message, unattended execution with mutating tools is vulnerable to prompt injections or accidental destruction.
- **Solution**:
  - **Explicit Human Command**: Full tool permissions.
  - **Autonomous / Inferred Wakeup**: Restricted to read-only tools (`Read`, `Grep`, `Glob`, inspect). Mutating commands, git push, or persistent memory writes are blocked.
  - If a change is needed, emit an `attention` request asking the human for permission. Once approved, the next turn runs with full tools.

### Lesson 2: "Don't Let the Agent Guess Your Presence" (Presence Detection)
- **Problem**: Instructing an LLM to "only message my phone if I am not at my computer" fails because models cannot know physical user presence.
- **Solution**:
  - System-level idle time checking (e.g. macOS `ioreg -c IOHIDSystem` to check keyboard/mouse idle seconds).
  - If user is active (< 5 min idle): Keep quiet on mobile; log to terminal or macOS notification center.
  - If user is away (≥ 5 min idle): Dispatch critical updates to Feishu / WeChat mobile bot.
  - Quiet hours (23:00 - 08:00): Batch non-critical notifications into a morning digest at 08:30.

### Lesson 3: "Waking Up Costs Real Money" (Token & Budget Guard)
- **Problem**: Frequent autonomous wakeups can rapidly drain token quotas or budget.
- **Solution**:
  - **Cooldown**: Minimum 3-minute gap between autonomous wakeups.
  - **Daily Limit**: Cap autonomous wakeups (e.g. max 48 per day).
  - **Gate Filtering**: Rule-based screening before invoking model assessors.

### Lesson 4: "Not All Events Push Themselves" (Active Watchers / "盯梢")
- **Problem**: Pull-based event sources (PR status changes, CI checks, doc comments) have no webhooks.
- **Solution**:
  - Configurable `watchers` in `settings.yaml`.
  - Runs lightweight diff commands periodically (e.g. every 5-10m). Only outputs that generate new lines or state changes generate an Inbox event.

---

## 4. Configuration Specification (`settings.yaml`)

```yaml
# Existing base configuration
stateDir: /Users/smallnest/ai/superagent/.superagent
checkout: /Users/smallnest/ai/superagent

github:
  enabled: true
  repository: smallnest/superagent
  cli: gh
  pollSeconds: 60
  allowed: [smallnest]

feishu:
  enabled: true
  cli: lark-cli
  chats:
    - chatId: oc_xxx
      name: Team
  syncChat: oc_xxx

# New: Always-On Superagent Enhancements

# 1. Presence & Human Attention Budget
attention:
  idleSecondsThreshold: 300 # Away if idle for 5+ mins
  quietHours:
    enabled: true
    start: "23:00"
    end: "08:00"
    morningDigestAt: "08:30"
  minNotifyIntervalMinutes: 10
  maxDailyNotifications: 25

# 2. Token & Autonomous Wakeup Guard
budget:
  autonomousCooldownSeconds: 180
  maxAutonomousWakesPerDay: 48

# 3. Autonomous Timers & Schedules
timers:
  enabled: true
  schedules:
    - id: daily-standup
      cron: "0 9 * * *"
      prompt: "Summarize status of all open and active tickets in one sentence for the team chat."

# 4. Pull-based Watchers
watchers:
  - id: watch-prs
    intervalMinutes: 10
    command: "gh pr list --repo smallnest/superagent --state open --json number,title,updatedAt"
    instruction: "Perform a read-only code review when a new PR or PR update is detected."
```

---

## 5. Implementation Roadmap

1. **Phase 1: Presence Detection & Outbox Attention Throttling**
   - Add OS idle check utility (`src/infra/presence.ts`).
   - Wire presence routing into `send()` in `src/runner.ts`: desktop notification when present, mobile push when absent.
   - Enforce read-only tools on autonomous runs in runner prompts/args.

2. **Phase 2: Timers Engine & Ticket Follow-ups**
   - Implement durable timer store under `.superagent/timers/`.
   - Allow agents to specify `followupAfterSeconds` in `report.json`.
   - Incorporate timer evaluation into `runLoop()`.

3. **Phase 3: Watchers Subsystem & Wakeup Budget Guard**
   - Add lightweight command runner and diff detector for `watchers`.
   - Track daily autonomous wakeups in durable state metadata.
