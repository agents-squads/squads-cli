# Agents Squads System Architecture

## Status: DRAFT v2

---

## 1. What This Document Is

The constitution for how agents run — from a solo dev running `squads run` on their laptop to our 99-agent workforce on the platform. Covers the open-source CLI, the hosted platform, and the upgrade path between them.

---

## 2. The Three Layers

### Strategic Principle: Sequential is Free, Concurrent Orchestration is the Product

Running 100 agents sequentially is trivial. Each runs, finishes, next starts. No conflicts. Layer 2 does this perfectly.

Running 5 agents **concurrently** breaks everything:
- Two agents edit the same file → merge conflict
- Two agents read state, both decide to act → duplicate/contradictory work
- Agents compete for git locks, API rate limits, file system access
- One agent's output invalidates another's in-progress work
- Local agent and cloud agent both want to commit to same repo

**Sequential = free forever. Concurrent without interference = the product.**

The harder the concurrency problem, the more valuable the orchestration:

| Concurrency | Difficulty | Who solves it |
|-------------|-----------|---------------|
| 1 agent at a time | Trivial | Layer 2 (free) |
| 2-3 concurrent, same repo | Manageable | Layer 2 (basic PID/lock files) |
| 5+ concurrent, same repo | Hard (git conflicts, state races) | Layer 3 (orchestration engine) |
| 10+ concurrent, local + cloud | Very hard (cross-environment coordination) | Layer 3 (hybrid orchestration) |
| 50+ concurrent, multi-repo, team | Chaos without orchestration | Layer 3 + consulting |

**Free = unlimited agents, unlimited scale, run one at a time or manage concurrency yourself.**
**Paid = concurrent orchestration (local + cloud) that eliminates interference.**

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: squads-cli (OSS, FREE)                                │
│  Zero infrastructure. Markdown files + Claude Code.             │
│                                                                  │
│  squads init → squads run company/coo → output in terminal      │
│  Memory: .agents/memory/ (git-tracked markdown files)           │
│  Scheduling: manual, cron, GitHub Actions — user's choice       │
│  Auth: User's own Claude/OpenAI/Gemini API key or subscription  │
│  Data: File system only. No database. No server.                │
│                                                                  │
│  Everything to run an AI workforce locally.                      │
│  No artificial limits. No "free tier" caps.                      │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 2: squads autonomous (OSS, FREE)                         │
│  Local daemon. Full scheduling + process management.            │
│  No Postgres. No Redis. No Docker. Just a node process.         │
│                                                                  │
│  squads autonomous start → reads SQUAD.md routines → spawns     │
│  agents on schedule via squads run --background                  │
│  Process tracking: PID files in .agents/logs/                   │
│  Timeout enforcement, concurrency control, auto-restart         │
│  Scale on YOUR infra — unlimited agents, unlimited concurrency  │
│                                                                  │
│  Full local scheduling (cron from SQUAD.md)                      │
│  Auto-scaling on user's own hardware (no limits)                 │
│  Per-agent memory, briefs, basic agent-to-agent communication   │
│  Multi-LLM support (Claude, GPT, Gemini, Ollama)                │
│  Basic evals and quality checks                                  │
│  No coordination engine (agents are independent islands)         │
│  No collective learning (agent A doesn't teach agent B)          │
│  No quality scoring or regression detection                      │
│  No observability dashboard or execution traces                  │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 3: squads platform (HOSTED, PAID)                        │
│  Concurrent orchestration — local + cloud. Our business.        │
│                                                                  │
│  "Run unlimited agents for free.                                │
│   Pay when you need them running concurrently without slop."    │
│                                                                  │
│  CORE VALUE: CONCURRENCY ORCHESTRATION                          │
│  - Resource locking (git, files, APIs — no two agents collide)  │
│  - Dependency graphs (agent B waits for agent A's output)       │
│  - Conflict resolution (2 agents want same file → sequence)     │
│  - Work deduplication (prevent redundant concurrent runs)       │
│  - Hybrid local + cloud execution (coordinate across both)      │
│  - Smart triggers (event chains, not just cron)                  │
│                                                                  │
│  WHAT MAKES CONCURRENCY WORK:                                    │
│  - Collective memory (agent A's output feeds agent B in real     │
│    time, not next run)                                           │
│  - Quality scoring (detect when concurrent agents produce slop)  │
│  - Execution traces (debug which concurrent agent broke what)    │
│  - Cost attribution (which agent is burning your budget?)        │
│  - Human-in-loop approvals (Slack gate before risky actions)     │
│                                                                  │
│  MANAGED HOSTING:                                                │
│  - Zero-ops cloud execution (Cloud Run)                          │
│  - Local + cloud hybrid (some agents local, some cloud)          │
│  - Multi-region, tenant isolation, auto-scaling                  │
│  - Team features: RBAC, workspaces, SSO, audit logs             │
│                                                                  │
│  Revenue: Usage-based pricing + consulting upsell               │
└─────────────────────────────────────────────────────────────────┘
```

### Upgrade Path (User Journey)

```
Developer discovers squads-cli via npm/GitHub/AI search
    │
    ▼
squads init → squads run engineering/pr-reviewer
"Wow, this reviewed my PR automatically"                    ← LAYER 1
    │
    ▼
squads autonomous start
"20 agents run on my machine on schedule, one at a time"    ← LAYER 2
    │
    ▼ User wants agents on every push, concurrent on PRs
    │ "My agents keep conflicting when they run together"
    │ "Two agents committed to the same branch simultaneously"
    │ "I need some agents on cloud but they share state with local"
    │
squads login → agents-squads.com orchestrates concurrency
"5 agents run concurrently without conflicts, local + cloud" ← LAYER 3
    │
    ▼ "I need 50 concurrent agents across repos, for my team"
    │
Book consulting call → we architect their AI workforce       ← REVENUE
```

### Why This Works Commercially

Sequential execution scales infinitely for free. The pain hits when users need **concurrency**:

| User need | Free (L1/L2) | Paid (L3) |
|-----------|-------------|-----------|
| "Run PR reviewer daily" | `squads autonomous` — done | Not needed |
| "Run PR reviewer + security audit on every push" | Both fire, occasionally conflict on comments | Orchestrated: security runs first, PR reviewer sees its output |
| "Run 10 agents across 3 repos simultaneously" | Git conflicts, stale reads, duplicate work | Resource locking, dependency graphs, deduplication |
| "Local agents + cloud agents working on same codebase" | Manual coordination, prayer | Hybrid orchestration with state sync |
| "50 agents, 5 teams, production reliability" | Chaos | Full platform with observability + approvals |

Users don't fork the orchestration layer because concurrent coordination across local + cloud is genuinely hard. It's not a feature — it's distributed systems engineering.

---

## 3. Layer 1: squads-cli (Open Source)

### What It Is

A CLI tool that turns markdown files into autonomous AI agents. Works with any LLM. Zero infrastructure.

### Architecture

```
User's repo/
├── .agents/
│   ├── squads/
│   │   ├── engineering/
│   │   │   ├── SQUAD.md           # Squad mission, goals, routines
│   │   │   ├── pr-reviewer.md     # Agent definition
│   │   │   └── security-auditor.md
│   │   └── marketing/
│   │       ├── SQUAD.md
│   │       └── content-writer.md
│   ├── memory/
│   │   └── engineering/
│   │       └── pr-reviewer/
│   │           ├── state.md       # Last observed state
│   │           ├── output.md      # Last report
│   │           └── learnings.md   # Cross-run learnings
│   └── logs/                      # Execution logs (gitignored)
│       └── engineering/
│           ├── pr-reviewer-1707580800.log
│           └── pr-reviewer-1707580800.pid
└── package.json
```

### Commands (OSS)

| Command | Does | Infrastructure |
|---------|------|---------------|
| `squads init` | Scaffold .agents/ with templates | None |
| `squads run <squad/agent>` | Execute one agent | None |
| `squads run <squad/agent> --background` | Execute detached, write PID + log | None |
| `squads status` | Show squads, agents, memory | None |
| `squads memory read/write` | Read/write agent memory files | None |
| `squads goal set/list` | Track squad goals | None |
| `squads feedback add` | Track agent feedback | None |
| `squads learn` | Show agent learnings | None |
| `squads autonomous start/stop/status` | Local scheduling daemon | None |
| `squads login` | Connect to platform (optional) | Platform |

### What the CLI Does NOT Know About

- Tenants, workspaces, users (platform concepts)
- Smart triggers (platform concept)
- Billing, Stripe, usage metering (platform concept)
- Slack approvals (platform concept)
- Cloud Run execution (platform concept)
- Postgres, Redis (platform infrastructure)

**This separation is critical.** The CLI is a pure local tool. An OSS user installing squads-cli should never encounter a database connection error, a tenant table, or a billing concept.

### Dependencies to Clean (Current → Target)

| Current | Problem | Target |
|---------|---------|--------|
| `pg` | Postgres driver — OSS users don't need DB | Remove from CLI core, move to optional `squads-platform` package |
| `ioredis` | Redis client — OSS users don't need Redis | Remove from CLI core |
| `chalk` | Terminal colors | Write our own (10 lines) |
| `ora` | Spinners | Write our own (20 lines) |
| `minimatch` | Glob matching | Use Node.js built-in `path.matchesGlob()` (Node 22+) or simple impl |
| `inquirer` | Interactive prompts | Keep (complex, CLI framework-adjacent) |
| `commander` | CLI framework | Keep (locked in stack) |
| `gray-matter` | YAML frontmatter parser | Keep (reliable, small) |
| `dotenv` | .env loading | Write our own (15 lines) |

---

## 4. Layer 2: squads autonomous (Open Source)

### What It Is

A local daemon that evaluates cron schedules from SQUAD.md files and spawns agents via `squads run --background`. No database. No server. Just a node process with a timer.

### Current State

`squads autonomous` is currently a **stub** — it reads routines but doesn't actually execute them. Comment in code: "Full scheduler implementation pending."

### Target Architecture

```
squads autonomous start
    │
    ▼
┌──────────────────────────────────────────────────┐
│  Node.js daemon (single process)                  │
│                                                    │
│  Every 5 min:                                      │
│  1. Read SQUAD.md files for routines (cron exprs)  │
│  2. For each due agent:                            │
│     a. Check: is it already running? (PID file)    │
│     b. Check: concurrency limit (count PID files)  │
│     c. Spawn: squads run squad/agent --background  │
│  3. For each running agent:                        │
│     a. Check PID alive (process.kill(pid, 0))      │
│     b. If alive > timeout: kill + log              │
│     c. If dead: cleanup PID file, log result       │
│                                                    │
│  PID file: ~/.squads/autonomous.pid                │
│  Config: .agents/squads/*/SQUAD.md (routines)      │
│  Logs: .agents/logs/{squad}/{agent}-{ts}.log       │
└──────────────────────────────────────────────────┘
```

### Key Differences from Platform Scheduler

| Feature | squads autonomous (L2) | Platform scheduler (L3) |
|---------|----------------------|------------------------|
| Cron evaluation | Parse SQUAD.md files | Postgres triggers table |
| Smart triggers | No | Yes (SQL conditions) |
| Process tracking | PID files | PID files + DB records |
| Concurrency | Count PID files | DB count + Redis locks |
| Budget tracking | Optional (local file) | Postgres + Redis cache |
| Multi-tenant | No (single repo) | Yes (workspace isolation) |
| Cloud execution | No (local only) | Yes (Cloud Run) |
| Alerts | stdout/stderr | Slack integration |
| Dashboard | `squads autonomous status` (terminal) | /ops/ web console |

### This is Where We Simplify

The platform scheduler (scheduler.py, ~1,900 lines) does what `squads autonomous` should do for local execution, PLUS platform-only features. The refactor:

1. Extract local scheduling logic into `squads autonomous` (CLI, TypeScript)
2. Platform scheduler becomes thin wrapper: platform features + calls `squads run --background`
3. Both use the same execution path: `squads run --background` → PID + log files

---

## 5. Deployment Model: Local → Cloud

### Local = Onboarding & Development

Users build and iterate on agents locally. This is free, fast, and private.

```bash
squads init                              # Scaffold
vim .agents/squads/eng/pr-reviewer.md    # Create agent
squads run eng/pr-reviewer               # Test it
# Tweak prompt, test again, repeat until quality is good
squads autonomous start                  # Test scheduling locally
squads autonomous status                 # Verify it fires correctly
```

No cloud, no account, no cost beyond their own API key. The agent is "onboarded" when it produces quality output consistently.

### Cloud = Semi-Autonomous Production

Once agents work well locally, deploy to cloud for autonomous execution with guardrails.

```bash
squads login                             # Connect to platform
squads deploy                            # Push .agents/ to platform
# Or: git push → webhook → platform syncs automatically
```

What happens on deploy:
1. Platform reads `.agents/` directory
2. Creates triggers from SQUAD.md schedules
3. Sets up concurrency rules (from agent frontmatter)
4. Agents start running on Cloud Run (or platform's local infra)
5. User monitors via `/ops/` dashboard

### Semi-Autonomous Governance

Agents run on their own, but within guardrails. Not fully autonomous (dangerous), not fully manual (defeats the purpose).

| Guardrail | How it works |
|-----------|-------------|
| **Approvals** | Agent wants to merge PR / send email / spend money → Slack notification → human approves or rejects |
| **Quality gates** | Output quality drops below threshold → agent auto-paused → human notified |
| **Budget caps** | Agent burning through API credits → throttled → human alerted |
| **Escalations** | Agent encounters something it can't handle → escalates to human queue |
| **Blast radius** | Agent can only modify files/repos in its SQUAD.md scope — no cross-squad contamination |

### The Deployment Lifecycle

```
LOCAL (iterate)          READINESS CHECK      DEPLOY              CLOUD (run)
──────────────           ───────────────      ──────              ───────────
Create agent
Test manually            squads eval ──────→ 80%+ readiness?
Tweak prompt             Fix warnings         ↓ yes
Test scheduling                              squads deploy ────→ Platform creates triggers
Validate output                                                  Agent runs on schedule
                                                                 Concurrent orchestration
                                                                 Continuous quality monitoring
                                                                 Human-in-loop approvals
                          ←──── squads pull                       Budget enforcement
Update locally ──────→   squads eval ──────→ squads deploy ────→ Platform updates triggers
                                                                 Zero-downtime rollout
```

`squads pull` = bring cloud state back to local (execution logs, learned patterns, quality scores). The loop is bidirectional.

### Agent Readiness Score

Before deploying to cloud, we need to know: **is this agent ready to work autonomously?**

An agent shouldn't go to production just because the user typed `squads deploy`. We need a readiness check — like CI/CD for agents.

```bash
squads eval eng/pr-reviewer
```

Output:
```
Agent Readiness: eng/pr-reviewer

  Definition quality     ██████████ 10/10  ✓ Has role, model, schedule, timeout
  Local runs completed   ████████░░  8/10  ✓ 8 successful runs, 0 failures
  Output consistency     ██████░░░░  6/10  ⚠ Output format varies across runs
  Memory utilization     ████░░░░░░  4/10  ⚠ Agent doesn't read its own state.md
  Error recovery         ██████████ 10/10  ✓ Handled API errors gracefully
  Resource safety        ██████████ 10/10  ✓ No destructive actions detected
  Cost predictability    ████████░░  8/10  ✓ Avg $0.12/run, std dev $0.03

  Overall readiness:     80% — READY with warnings

  Recommendations:
  - Standardize output format (add output template to agent definition)
  - Add RECALL step to read state.md before acting
```

**Readiness dimensions:**

| Dimension | What it measures | How |
|-----------|-----------------|-----|
| **Definition quality** | Is the agent well-defined? | Check frontmatter completeness, instruction clarity |
| **Execution reliability** | Does it run without errors? | Track success/failure ratio over N local runs |
| **Output consistency** | Is output predictable? | Compare output structure across runs (not content, structure) |
| **Memory utilization** | Does it learn across runs? | Check if agent reads AND writes state.md/learnings.md |
| **Error recovery** | Does it handle failures? | Inject failures (API timeout, missing file) and verify graceful handling |
| **Resource safety** | Can it cause damage? | Detect destructive patterns (force push, delete, overwrite) |
| **Cost predictability** | Is spend consistent? | Track token usage variance across runs |

**Readiness gates for deployment:**

| Level | Requirement | Can deploy to |
|-------|------------|---------------|
| **Untested** | No local runs | Nowhere (must test locally first) |
| **Development** | 1+ successful local run | Local autonomous (L2) with supervision |
| **Staging** | 5+ runs, >80% success, <$1 avg cost | Cloud with approval gates |
| **Production** | 10+ runs, >95% success, consistent output, memory working | Cloud autonomous (semi-autonomous with guardrails) |

This is Layer 2 functionality (free) for the scoring. Layer 3 adds:
- Continuous readiness monitoring in production (quality regression detection)
- Automatic demotion if quality drops (production → staging → paused)
- Team-level readiness dashboards
- Readiness requirements per squad/workspace

---

## 6. Layer 3: Platform (Our Business)

### What It Adds Over OSS

```
┌──────────────────────────────────────────────────────────────┐
│  PLATFORM (hosted at agents-squads.com)                      │
│                                                               │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐   │
│  │ Scheduler  │  │ Admin      │  │ Cloud Workers        │   │
│  │ (Python)   │  │ Console    │  │ (Cloud Run)          │   │
│  │            │  │ (Astro)    │  │                      │   │
│  │ - Triggers │  │ - /ops/    │  │ - Tenant-isolated    │   │
│  │ - Budget   │  │ - Dashboard│  │ - API key per tenant │   │
│  │ - Events   │  │ - Exec log │  │ - Callback on done   │   │
│  │ - Webhooks │  │ - Triggers │  │                      │   │
│  └─────┬──────┘  └─────┬──────┘  └──────────┬───────────┘   │
│        │               │                     │               │
│  ┌─────▼───────────────▼─────────────────────▼───────────┐   │
│  │                 PLATFORM DATABASE                      │   │
│  │                                                        │   │
│  │  Platform-only tables:                                 │   │
│  │  - tenants (workspaces)                                │   │
│  │  - users (RBAC)                                        │   │
│  │  - triggers (smart triggers, conditions)               │   │
│  │  - trigger_executions (history, logs, costs)           │   │
│  │  - approvals (Slack human-in-loop)                     │   │
│  │  - escalations (agent escalation queue)                │   │
│  │  - events (GitHub webhooks, Slack events)              │   │
│  │  - billing (Stripe, usage metering)                    │   │
│  │  - leads (signup tracking)                             │   │
│  │                                                        │   │
│  │  NONE of these tables exist in squads-cli               │   │
│  │  OSS users NEVER connect to this database               │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐   │
│  │                 PLATFORM SERVICES                      │   │
│  │  Redis: distributed locks, budget cache, event buffer  │   │
│  │  Slack: bot + worker for approvals                     │   │
│  │  Bridge: telemetry ingestion (OTEL → Postgres)         │   │
│  │  GitHub App: webhook registration per tenant           │   │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### Platform Scheduler (scheduler.py — simplified)

After the refactor, scheduler.py shrinks from ~1,900 lines to ~500 lines:

**Keeps:**
- Procrastinate integration (job queue)
- Smart trigger evaluation (SQL conditions against events table)
- Budget tracking (Postgres + Redis)
- Distributed locking (Redis)
- Cloud Run dispatch (for cloud executor agents)
- Slack alerting (failures, budget, circuit breakers)
- Webhook handling (GitHub events → triggers)

**Drops (moved to CLI):**
- `build_claude_command()` — CLI builds its own commands
- tmux session management — replaced by PID file polling
- Context injection (SQUAD.md, briefs, learnings) — CLI does this
- Auto-commit — CLI does this
- Agent frontmatter parsing (duplicated) — CLI does this

**Execution path:**
```python
# OLD (scheduler.py builds everything itself):
cmd = build_claude_command(agent, squad, budget, ...)  # 40 lines
tmux_session = f"squads-{squad}-{agent}-{ts}"
subprocess.run(["tmux", "new-session", "-d", "-s", tmux_session, cmd])
# Then poll tmux sessions every 2 min to check completion

# NEW (scheduler.py delegates to CLI):
subprocess.Popen(
    ["squads", "run", f"{squad}/{agent}", "--background", "--trigger", "scheduled"],
    cwd=repo_path,
    env={**os.environ, "SQUADS_EXECUTION_ID": execution_id}
)
# Then poll PID files every 2 min to check completion
```

### Admin Console (squads-admin)

- Extends existing Astro console at `engineering/infrastructure/services/console/`
- 6 new pages under `/ops/` prefix
- Reads from scheduler API (SSR, server-to-server)
- Auth: Google OAuth (existing)

---

## 7. Core Principle: CLI is the Execution Engine

**Rule**: Every agent execution — manual, autonomous, platform-scheduled — goes through `squads run`.

```bash
Manual:     squads run company/coo
Autonomous: squads autonomous → squads run company/coo --background
Platform:   scheduler.py → squads run company/coo --background --trigger scheduled
Cloud:      Cloud Run worker → squads run company/coo --trigger smart
```

**Why**: One code path = one behavior = fewer bugs. The CLI already handles:

| Concern | CLI handles | Scheduler should NOT |
|---------|------------|---------------------|
| Context injection (SQUAD.md, memory, briefs) | Yes | No |
| Claude command building | Yes | No (currently duplicates) |
| Process spawn + PID file | Yes | No (currently uses tmux) |
| Log capture | Yes | No |
| Auto-commit agent work | Yes | No |
| Auth handling (strip API key) | Yes | No |
| Model routing | Yes | No |
| Telemetry flush | Yes | No |

| Concern | Scheduler handles | CLI should NOT |
|---------|------------------|---------------|
| When to run (cron, smart triggers) | Yes | No |
| Budget enforcement | Yes | No |
| Concurrency limiting | Yes | No |
| Completion monitoring (poll PIDs) | Yes | No |
| Timeout enforcement (kill PIDs) | Yes | No |
| Failure alerting (Slack) | Yes | No |
| Multi-tenant isolation | Yes | No |

---

## 8. Process Management Contract

### PID Files (used by both Layer 2 and Layer 3)

```
Location: .agents/logs/{squad}/{agent}-{timestamp}.pid
Content: Single line with PID number
Created by: squads run --background
Read by: squads autonomous (L2) or scheduler.py (L3)
Cleaned up by: monitoring loop after process exits
```

### Log Files

```
Location: .agents/logs/{squad}/{agent}-{timestamp}.log
Content: Claude --print output (stdout + stderr)
Created by: squads run --background
Read by: monitoring loop for completion detection
Retention: 7 days (configurable)
```

### Execution Lifecycle

```
Status Flow:
  → running → completed
            → failed
            → timeout

Layer 2 (autonomous):
  Cron due → spawn squads run --background → PID file created → poll → done

Layer 3 (platform):
  Trigger fires → create DB record (status=running) → spawn squads run --background
  → PID file created → poll PID → on exit: update DB record → done
```

Note: Layer 3 drops the `queued` status. The scheduler either spawns immediately or skips (concurrency/budget limit). No queue = no stuck-queued bug.

---

## 9. Concurrency & Budget

### Layer 2 (autonomous — local)

```
MAX_CONCURRENT = 5 (default, configurable in SQUAD.md or env)
Counting: ls .agents/logs/**/*.pid | wc -l
Per-agent: only 1 instance (check PID file exists before spawn)
Budget: none enforced (user pays their own API costs)
```

### Layer 3 (platform — hosted)

```
MAX_CONCURRENT_AGENTS = 5 (per workspace, configurable)
Counting: SELECT COUNT(*) FROM trigger_executions WHERE status = 'running' AND tenant_id = ?

NOTE: Count ONLY 'running'. No 'queued' status exists.

Per-agent: Redis distributed lock (prevents duplicate runs across workers)
Budget:
  - Per workspace daily cap (default $50)
  - Alert at 80%, stop at 100%
  - Reset at midnight UTC
  - Tracked in Redis (fast), persisted to Postgres (durable)
```

---

## 10. Context Contract (What Every Agent Receives)

Identical across all three layers. The CLI injects this:

### Environment Variables
```bash
SQUADS_SQUAD=company
SQUADS_AGENT=coo
SQUADS_TRIGGER=manual|scheduled|smart|event  # How it was triggered
SQUADS_EXECUTION_ID=...                       # Platform only (empty for L1/L2)
BRIDGE_API=http://localhost:8088              # Platform only (empty for L1/L2)
```

### Prompt Context (assembled by CLI)
```
1. Agent definition (.agents/squads/{squad}/{agent}.md)
2. Squad context (SQUAD.md — mission, goals, constraints)
3. Agent state (.agents/memory/{squad}/{agent}/state.md)
4. Agent learnings (.agents/memory/{squad}/{agent}/learnings.md)
5. Squad briefs (.agents/memory/{squad}/_briefs/)
6. Agent briefs (.agents/memory/{squad}/{agent}/briefs/)
```

Same context whether `squads run` is called manually, by autonomous, or by the platform scheduler.

---

## 11. Failure Handling

### Layer 2 (autonomous)

| Condition | Action |
|-----------|--------|
| PID alive > timeout (default 30 min) | SIGTERM → wait 5s → SIGKILL |
| PID dead, log exists | Mark complete, cleanup PID file |
| Orphan PID file (no process) | Cleanup PID file |
| Daemon crash | PID files remain, restart picks them up |

### Layer 3 (platform)

| Condition | Action | Alert |
|-----------|--------|-------|
| Running > 30 min | SIGTERM → SIGKILL | Slack warning |
| Running > 4 hours | Force kill, mark zombie | Slack critical |
| Budget > 80% | Continue, warn | Slack info |
| Budget > 100% | Stop all agents | Slack critical |
| Redis down | Skip locking (allow execution) | Slack warning |
| Postgres down | Stop scheduler | Slack critical |
| 3+ failures in 1 hour for same agent | Disable trigger | Slack warning |

---

## 12. Local vs Cloud Execution (Platform Only)

| Aspect | Local (Mac/VM) | Cloud (GCP Cloud Run) |
|--------|---------------|----------------------|
| Trigger | Same scheduler | Same scheduler |
| Execution | `squads run --background` | HTTP POST to Cloud Run worker |
| Process tracking | PID file + poll | Callback URL on completion |
| Context | CLI injects | Cloud worker injects (same CLI) |
| Auth | Max subscription (OAuth) | ANTHROPIC_API_KEY (Secret Manager) |
| Timeout | Scheduler kills PID | Cloud Run timeout (30 min) |
| Log | Local file | Cloud Run logs |
| Cost | Subscription included | API credits per token |
| Multi-tenant | Single repo | Per-tenant isolation |

**Default**: All agents run locally.
**Cloud**: Tenant-isolated execution, heavy compute, or pay-per-use billing.

---

## 12.1. Security: Infrastructure-Level Tenant Isolation (HARD CONSTRAINT)

### The Threat: Prompt Injection → Cross-Tenant Data Leak

Agents process untrusted input: GitHub issues, emails, web content, user prompts. Prompt injection is not a theoretical risk — it's an expected attack vector. A compromised agent will attempt to read data, exfiltrate secrets, and execute arbitrary actions.

**If tenants share infrastructure, a prompt injection on Tenant A's agent can access Tenant B's data.** This is not acceptable.

### The Rule: No Shared Infrastructure Between Tenants

Every tenant gets its own isolated stack. No exceptions.

```
WRONG (shared infra):                    RIGHT (isolated infra):

┌─────────────────────────┐              ┌──────────────┐  ┌──────────────┐
│  Shared Postgres        │              │  Tenant A    │  │  Tenant B    │
│  ├── tenant_a.data      │              │  ├── Postgres│  │  ├── Postgres│
│  └── tenant_b.data      │              │  ├── Redis   │  │  ├── Redis   │
│  Shared Redis           │              │  ├── Workers │  │  ├── Workers │
│  Shared Cloud Run       │              │  └── Secrets │  │  └── Secrets │
│                         │              └──────────────┘  └──────────────┘
│  Agent A compromised →  │              Agent A compromised →
│  reads ALL tenant data  │              reads only Tenant A data
└─────────────────────────┘
```

### What Gets Isolated Per Tenant

| Resource | Isolation method |
|----------|-----------------|
| **Database** | Separate Cloud SQL instance (or separate database on shared instance with no cross-DB access) |
| **Redis** | Separate Memorystore instance (or key prefix with no cross-prefix access) |
| **Cloud Run workers** | Separate service per tenant, own service account |
| **API keys** | Per-tenant secrets in Secret Manager, own IAM bindings |
| **File system** | No shared volumes, no shared GCS buckets |
| **Network** | VPC-level isolation where possible |
| **Git repos** | Tenant agents never touch another tenant's repo |

### What CAN Be Shared (no tenant data)

| Resource | Why it's safe |
|----------|--------------|
| **Scheduler service** | Dispatches jobs, doesn't hold tenant data. Reads trigger config from per-tenant DB. |
| **Admin console** | Reads from per-tenant DB via tenant-scoped API calls. |
| **Auth service** | Stateless OAuth flow. Tokens are per-tenant. |
| **Container registry** | Same agent runtime image, different config per tenant. |

### Cost Implication

Infrastructure isolation costs more per tenant than shared-everything. This is intentional — it's the correct trade-off for an AI agent platform:

- A SaaS dashboard with row-level security? Shared infra is fine.
- An AI agent platform where agents execute arbitrary code against untrusted input? Infrastructure isolation is mandatory.

This cost is passed to the customer as part of the platform pricing. It's also why consulting includes infrastructure setup — we provision the isolated stack per engagement.

### Implementation Notes

- Use Terraform/Pulumi modules to stamp out per-tenant infrastructure
- Tenant provisioning is part of `squads deploy` (Phase 5)
- Deprovisioning must be automated (delete stack when tenant churns)
- Our own dogfooding tenant (tenant_id=1) follows the same rules

---

## 13. Migration Plan

### Phase 1: Fix the bleeding (Day 1) — PLATFORM ✅ DONE

Fixed the concurrency bug that blocked all agents.

- [x] Change concurrency check: count only `status='running'`, not `'queued'`
- [x] Reduce stale-queued threshold from 15 min to 5 min
- [x] Add Slack alert when circuit breaker trips
- [x] Increase MAX_CONCURRENT_AGENTS from 3 to 5

### Phase 2: Build squads autonomous + eval (Week 1) — CLI ✅ DONE

`squads autonomous` was already functional (652 lines). `squads eval` built. Infrastructure deps removed.

- [x] `squads autonomous` — fully functional daemon (cron eval, PID files, concurrency, timeout)
- [x] `squads eval <squad/agent>` — 5-dimension readiness scorer (PR #305)
- [x] Readiness gates: untested → development → staging → production
- [x] Remove `pg`, `ioredis`, `@supabase/supabase-js` from CLI dependencies (PR #303)

### Phase 3: Simplify platform scheduler (Week 2) — PLATFORM ✅ DONE

Replaced tmux with `squads run --background` for scheduled agents.

- [x] Scheduled agents now use `squads run --background` + PID file monitoring (same as smart triggers)
- [x] `build_claude_command()` restricted to Docker-only path
- [x] PID + log_path stored in `trigger_executions.context` JSON
- [x] Legacy tmux monitoring kept for in-flight executions (will be removed later)
- [x] `parse_execution_id()` helper for UUID/int schema compatibility

### Phase 4: Admin console (Week 3) — PLATFORM ✅ DONE

Built the /ops/ dashboard in the Astro admin console.

- [x] `src/lib/scheduler.ts` — scheduler API client (triggers, executions, stats, health)
- [x] `src/pages/ops/index.astro` — operations dashboard (stats, running agents, executions, triggers, failures)
- [x] Navigation: "Operations" link added to sidebar layout

### Phase 5: CLI → Platform upgrade path (Week 4) — BOTH ✅ DONE

- [x] `squads login` — already existed (Google OAuth, domain-based tenant detection)
- [x] `squads deploy` — pushes agent definitions to platform via `/triggers/sync` (PR #304)
- [x] `squads deploy status` — shows platform triggers and execution stats
- [x] `squads deploy pull` — pulls execution data and learnings from platform

---

## 14. What Gets Removed from CLI

These are currently in squads-cli but are platform concerns:

| Feature | Current Location | Move To |
|---------|-----------------|---------|
| Postgres connection (pg) | CLI dependency | Platform only |
| Redis connection (ioredis) | CLI dependency | Platform only |
| Cycle sync to DB | `cycle-sync.ts` | Platform telemetry endpoint |
| Dashboard snapshots to DB | `dashboard.ts` | Platform API |
| Tenant/workspace concepts | Login flow | Platform only |

**Result**: `npm install -g squads-cli` installs a clean tool with zero infrastructure dependencies. First run: `squads init && squads run engineering/pr-reviewer` — works immediately.

---

## 15. Configuration Reference

### Layer 1 (CLI — env vars, all optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | none | Claude API key (or use Max subscription) |
| `OPENAI_API_KEY` | none | For GPT-4 agents |
| `GOOGLE_API_KEY` | none | For Gemini agents |
| `SQUADS_MODEL` | `claude-sonnet-4` | Default model |

### Layer 2 (autonomous — env vars, all optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `SQUADS_MAX_CONCURRENT` | `5` | Max simultaneous agents |
| `SQUADS_AGENT_TIMEOUT` | `30` | Kill agent after N minutes |
| `SQUADS_EVAL_INTERVAL` | `5` | Check schedules every N minutes |

### Layer 3 (platform — env vars, required)

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | required | Postgres connection |
| `REDIS_URL` | required | Redis connection |
| `SQUADS_DAILY_BUDGET` | `50` | Daily spend cap (USD) per workspace |
| `MAX_CONCURRENT_AGENTS` | `5` | Max simultaneous per workspace |
| `AGENT_TIMEOUT_MINUTES` | `30` | Kill agent after N minutes |
| `SQUADS_SCHEDULER_URL` | `http://localhost:8090` | Scheduler API |
| `SLACK_BOT_TOKEN` | optional | For Slack integration |

### Agent Definition Schema (same across all layers)

```yaml
name: agent-name            # Unique within squad
squad: squad-name            # Squad assignment
role: "Brief description"    # 5-10 words
model: claude-sonnet-4       # haiku | sonnet | opus
executor: local              # local | cloud (cloud = platform only)
trigger: scheduled           # null | scheduled | smart | manual
schedule: "0 6 * * *"       # Cron expression
status: active               # active | probation | archived
budget:                      # Platform enforces, CLI ignores
  per_run: 0.50
  daily: 5.00
  monthly: 100.00
timeout: 300                 # Seconds
```

---

## 16. Verification

### Layer 1 (CLI)
```bash
npm install -g squads-cli
squads init                               # Creates .agents/
squads run engineering/pr-reviewer        # Runs agent, shows output
# No errors about Postgres, Redis, tenants, or missing services
```

### Layer 2 (autonomous)
```bash
squads autonomous start                   # Daemon starts
squads autonomous status                  # Shows: 2 running, 3 scheduled
# Wait for cron to fire
ls .agents/logs/engineering/pr-reviewer-*.pid  # PID file exists
# Agent completes
squads autonomous status                  # Shows: completed, next run in 23h
```

### Layer 3 (platform)
```bash
# Scheduler running
curl localhost:8090/health                # Shows running agents, budget
# Agent fires via smart trigger
psql -c "SELECT * FROM trigger_executions ORDER BY created_at DESC LIMIT 5"
# Shows execution with PID, log path, status=completed
```

### Upgrade path (L1 → L3)
```bash
squads login                              # Google OAuth → token stored
squads deploy                             # Pushes .agents/ to platform
# Open agents-squads.com/ops/             # See agents in dashboard
# Agent fires on schedule via platform
# User sees execution in /ops/executions
```

---

## 17. Critical Files

| File | Layer | Change | Phase |
|------|-------|--------|-------|
| `squads-scheduler/scheduler.py` | L3 | Fix concurrency (queued vs running) | 1 |
| `squads-scheduler/scheduler.py` | L3 | Replace build_claude_command + tmux with `squads run` | 3 |
| `squads-cli/src/commands/autonomous.ts` | L2 | Implement real daemon (cron + PID management) | 2 |
| `squads-cli/package.json` | L1 | Remove pg, ioredis | 2 |
| `squads-cli/src/commands/run.ts` | L1 | Ensure --background PID file is reliable | 2 |
| `squads-cli/src/commands/login.ts` | L1→L3 | Platform connection flow | 5 |
| `squads-cli/src/commands/deploy.ts` | L1→L3 | Push agents to platform | 5 |
| `engineering/.../console/` | L3 | Admin /ops/ pages | 4 |
| `docs/ARCHITECTURE.md` | All | This document | 1 |

---

## 18. Summary: What Changes

| Before | After |
|--------|-------|
| CLI needs pg, ioredis | CLI needs zero infrastructure |
| `squads autonomous` is a stub | `squads autonomous` is a real local daemon |
| Scheduler builds claude commands | Scheduler calls `squads run` |
| Scheduler uses tmux | Scheduler polls PID files |
| Tenant tables in local dev DB | Tenant tables only in platform DB |
| No clear OSS → platform path | `squads login` + `squads deploy` |
| 1,900 line scheduler.py | ~500 line scheduler.py + real autonomous.ts |
| `queued` status causes stuck agents | No queued status (spawn or skip) |
