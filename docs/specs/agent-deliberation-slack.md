# Agent Deliberation via Slack

**Status**: Draft
**Owner**: engineering
**Priority**: P1 (enables collaborative reasoning)
**Created**: 2026-01-31

---

## Problem

Agents are isolated executors. They receive instructions, execute, output results. No discussion. No reasoning together. No way for humans to see the decision-making process or influence it before execution.

**Current flow:**
```
Instruction → Agent executes → Output → Next agent reads → Executes
```

**Desired flow:**
```
Trigger → Agent posts intent → Discussion (agents + humans) → Consensus → Execute
```

---

## Why Slack?

| Requirement | Slack | Custom UI |
|-------------|-------|-----------|
| Humans already there | Yes | No (another app) |
| Threading | Built-in | Must build |
| Mobile | Native apps | Must build |
| Notifications | Built-in | Must build |
| Search | Built-in | Must build |
| We're building it | Yes (slack_worker.py) | More scope |

Slack is the pragmatic choice. It's where teams already collaborate.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Slack Workspace                          │
├─────────────────────────────────────────────────────────────┤
│  #squad-cli          - CLI squad deliberations              │
│  #squad-engineering  - Engineering squad deliberations      │
│  #squad-growth       - Growth squad deliberations           │
│  #decisions          - Cross-squad decisions (read-only)    │
│  #escalations        - Human attention required             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Deliberation Service                        │
│  (extension of slack_worker.py)                              │
├─────────────────────────────────────────────────────────────┤
│  - Agent posts intent before major actions                  │
│  - Routes to relevant channels                              │
│  - Manages deliberation state (open/closed)                 │
│  - Tracks participants and decisions                        │
│  - Enforces timeouts and escalations                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Postgres Tables                           │
│  deliberations, deliberation_participants, decisions        │
└─────────────────────────────────────────────────────────────┘
```

---

## Channel Structure

### Per-Squad Channels

Each squad gets a deliberation channel: `#squad-{name}`

| Channel | Purpose | Who Posts |
|---------|---------|-----------|
| `#squad-cli` | CLI squad decisions | issue-solver, code-eval, cli-lead, humans |
| `#squad-engineering` | Infra/platform decisions | infra-lead, security-critic, humans |
| `#squad-growth` | GTM decisions | lead-finder, outreach-writer, humans |
| `#squad-intelligence` | Research/analysis | intel-analyst, trend-watcher, humans |

### Cross-Squad Channels

| Channel | Purpose | Who Posts |
|---------|---------|-----------|
| `#decisions` | All significant decisions (read-only digest) | Deliberation service |
| `#escalations` | Needs human attention | Any agent |

---

## Message Types

### 1. Intent (Agent → Channel)

Posted before major actions. Opens deliberation.

```
┌────────────────────────────────────────────────────────────┐
│ 🤖 issue-solver                                             │
├────────────────────────────────────────────────────────────┤
│ *Intent: Fix authentication bug*                           │
│                                                            │
│ Found SQL injection in `login.ts:47`. Planning to:         │
│ 1. Add parameterized queries                               │
│ 2. Add input validation layer                              │
│                                                            │
│ Estimated: 2 files, ~50 lines changed                      │
│                                                            │
│ ⏱️ Proceeding in 15 min unless objections                   │
│                                                            │
│ [Approve ✓] [Object ✗] [Need Info ?]                       │
└────────────────────────────────────────────────────────────┘
```

### 2. Consultation (Agent → Agent)

Agent explicitly requests input from another agent.

```
┌────────────────────────────────────────────────────────────┐
│ 🤖 issue-solver                                             │
├────────────────────────────────────────────────────────────┤
│ @security-critic Need your analysis before I fix this.     │
│                                                            │
│ Context: SQL injection in auth flow                        │
│ Question: Any broader attack surface I should check?       │
│                                                            │
│ [Respond] [Pass]                                           │
└────────────────────────────────────────────────────────────┘
```

Response (threaded):
```
│ 🤖 security-critic                                          │
│ Good catch. Also check:                                    │
│ - `register.ts` (same pattern)                            │
│ - `reset-password.ts` (similar flow)                      │
│                                                            │
│ Recommend: Add SQL injection tests to CI after fix.        │
└────────────────────────────────────────────────────────────┘
```

### 3. Decision (Channel → Record)

Posted when deliberation closes.

```
┌────────────────────────────────────────────────────────────┐
│ ✅ Decision: Fix authentication bug                         │
├────────────────────────────────────────────────────────────┤
│ *Approved after 12 min deliberation*                       │
│                                                            │
│ Participants: issue-solver, security-critic, @jorge        │
│ Outcome: Proceed with expanded scope                       │
│                                                            │
│ Changes:                                                   │
│ - Original: 2 files → Expanded: 4 files                    │
│ - Added: CI test requirement                               │
│                                                            │
│ PR: #234 (in progress)                                     │
└────────────────────────────────────────────────────────────┘
```

### 4. Escalation (Agent → #escalations)

When agent needs human judgment.

```
┌────────────────────────────────────────────────────────────┐
│ 🚨 Escalation: Budget decision needed                       │
├────────────────────────────────────────────────────────────┤
│ growth-lead needs human input                              │
│                                                            │
│ Question: Approve $500 ad spend for LinkedIn campaign?     │
│                                                            │
│ Context:                                                   │
│ - Monthly budget: $2000                                    │
│ - Spent this month: $1200                                  │
│ - Projected ROI: 3x based on last campaign                 │
│                                                            │
│ [Approve] [Reject] [Modify Amount]                         │
└────────────────────────────────────────────────────────────┘
```

---

## Deliberation Protocol

### When to Deliberate

Agents post Intent before:

| Action Type | Deliberation Required | Timeout |
|-------------|----------------------|---------|
| Create PR (>20 lines) | Yes | 15 min |
| External API calls | Yes | 10 min |
| Spending >$50 | Yes + Human approval | No timeout |
| Delete/modify data | Yes | 15 min |
| Cross-squad impact | Yes | 30 min |
| Simple bug fix (<20 lines) | No (post-hoc notify) | — |

### Deliberation States

```
┌─────────┐    ┌──────────┐    ┌──────────┐
│  OPEN   │───▶│ DECIDING │───▶│ CLOSED   │
└─────────┘    └──────────┘    └──────────┘
     │              │               │
     │              │               ├── approved
     │              │               ├── rejected
     │              │               ├── modified
     │              │               └── timeout_approved
     │              │
     │              └── objection raised
     │
     └── intent posted
```

### Timeout Behavior

| Scenario | Default Behavior |
|----------|------------------|
| No response in timeout | Proceed (timeout_approved) |
| Objection raised | Pause, wait for resolution |
| Human joins thread | Extend timeout 30 min |
| Explicit approval | Proceed immediately |

### Participation Rules

1. **Any agent** in the squad can participate
2. **Humans** can join any deliberation
3. **Cross-squad agents** can be @mentioned
4. **Objections** pause execution until resolved
5. **Human override** always takes precedence

---

## Database Schema

```sql
-- Deliberation threads
CREATE TABLE squads.deliberations (
    id SERIAL PRIMARY KEY,
    deliberation_id TEXT UNIQUE NOT NULL,  -- uuid
    squad TEXT NOT NULL,
    initiator_agent TEXT NOT NULL,
    intent_type TEXT NOT NULL,  -- 'pr', 'api_call', 'spend', 'data_modify', 'cross_squad'
    intent_summary TEXT NOT NULL,
    intent_details JSONB DEFAULT '{}',

    -- Slack reference
    slack_channel TEXT NOT NULL,
    slack_ts TEXT NOT NULL,  -- Thread timestamp
    slack_team_id TEXT,

    -- State
    status TEXT DEFAULT 'open',  -- open, deciding, closed
    outcome TEXT,  -- approved, rejected, modified, timeout_approved
    timeout_at TIMESTAMPTZ NOT NULL,

    -- Tracking
    created_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    decision_summary TEXT
);

-- Who participated
CREATE TABLE squads.deliberation_participants (
    id SERIAL PRIMARY KEY,
    deliberation_id TEXT REFERENCES squads.deliberations(deliberation_id),
    participant_type TEXT NOT NULL,  -- 'agent', 'human'
    participant_id TEXT NOT NULL,  -- agent name or slack user id
    action TEXT NOT NULL,  -- 'approve', 'object', 'comment', 'modify'
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Final decisions (queryable log)
CREATE TABLE squads.decisions (
    id SERIAL PRIMARY KEY,
    decision_id TEXT UNIQUE NOT NULL,
    deliberation_id TEXT REFERENCES squads.deliberations(deliberation_id),
    squad TEXT NOT NULL,
    summary TEXT NOT NULL,
    outcome TEXT NOT NULL,
    participants JSONB DEFAULT '[]',
    impact JSONB DEFAULT '{}',  -- files changed, cost, etc.
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ix_deliberations_squad ON squads.deliberations(squad);
CREATE INDEX ix_deliberations_status ON squads.deliberations(status);
CREATE INDEX ix_decisions_squad ON squads.decisions(squad);
```

---

## Integration with Agent Execution

### Before Execution Hook

```python
async def before_major_action(agent: str, action: ActionIntent) -> DeliberationResult:
    """Called before agent takes major action."""

    if not requires_deliberation(action):
        return DeliberationResult(proceed=True)

    # Post intent to Slack
    deliberation = await post_intent(
        squad=action.squad,
        agent=agent,
        intent_type=action.type,
        summary=action.summary,
        details=action.details,
        timeout_minutes=get_timeout(action.type),
    )

    # Wait for outcome (or timeout)
    result = await wait_for_deliberation(
        deliberation_id=deliberation.id,
        timeout=deliberation.timeout_at,
    )

    return result
```

### Agent Prompt Addition

Add to agent system prompts:

```markdown
## Deliberation Protocol

Before major actions, you MUST post an intent to Slack and wait for deliberation:

1. **Describe your intent** - What you plan to do and why
2. **Tag relevant agents** - @security-critic for security, @product-critic for UX, etc.
3. **Wait for response** - Proceed after timeout or explicit approval
4. **Incorporate feedback** - Modify your approach if objections raised

Major actions requiring deliberation:
- PRs with >20 lines changed
- External API calls
- Any spending
- Data modifications
- Cross-squad impacts

Use the `deliberate` tool to post intents and check status.
```

### New Agent Tool: `deliberate`

```python
@tool
async def deliberate(
    intent_type: Literal["pr", "api_call", "spend", "data_modify", "cross_squad"],
    summary: str,
    details: dict,
    mention_agents: list[str] = [],
    timeout_minutes: int = 15,
) -> DeliberationResult:
    """
    Post intent to squad channel and await deliberation.

    Returns:
        DeliberationResult with:
        - proceed: bool
        - outcome: 'approved' | 'rejected' | 'modified' | 'timeout_approved'
        - modifications: dict (if outcome is 'modified')
        - participants: list of who weighed in
    """
    ...
```

---

## Example Flows

### Flow 1: Simple PR (No Objections)

```
1. issue-solver finds bug
2. issue-solver calls deliberate(intent_type="pr", summary="Fix null check in auth")
3. Slack: Intent posted to #squad-cli
4. 15 min pass, no objections
5. deliberate() returns {proceed: True, outcome: "timeout_approved"}
6. issue-solver creates PR
7. Slack: Decision posted, PR linked
```

### Flow 2: Security Concern Raised

```
1. issue-solver posts intent for auth change
2. security-critic sees it (subscribed to #squad-cli)
3. security-critic objects: "This needs session invalidation too"
4. issue-solver acknowledges, modifies approach
5. security-critic approves modified approach
6. deliberate() returns {proceed: True, outcome: "modified", modifications: {...}}
7. issue-solver creates PR with expanded scope
```

### Flow 3: Human Intervention

```
1. growth-lead posts intent: "Send 500 cold emails"
2. @jorge sees notification, joins thread
3. @jorge: "Let's start with 50 and measure response"
4. growth-lead acknowledges modification
5. deliberate() returns {proceed: True, outcome: "modified", modifications: {count: 50}}
6. growth-lead sends 50 emails
```

### Flow 4: Cross-Squad Collaboration

```
1. cli/issue-solver needs to change API contract
2. Posts intent to #squad-cli, mentions @engineering/api-lead
3. api-lead joins from #squad-engineering
4. Discussion about backward compatibility
5. Agree on versioned endpoint approach
6. Both squads update their plans
```

---

## Human Participation

### Notifications

Humans receive notifications for:
- Any deliberation in squads they're members of
- Explicit @mentions
- Escalations to #escalations
- Spending decisions

### Actions Available

| Action | Effect |
|--------|--------|
| React ✅ | Approve (counts as vote) |
| React ❌ | Object (pauses execution) |
| Reply in thread | Participate in discussion |
| Use button [Approve] | Explicit approval, closes deliberation |
| Use button [Reject] | Explicit rejection, closes deliberation |

### Override Rules

1. Human explicit approval → Proceed immediately
2. Human explicit rejection → Stop, agent must acknowledge
3. Human modification → Agent must incorporate
4. No human response → Follow agent consensus + timeout

---

## Configuration

### Per-Squad Settings

```yaml
# .agents/squads/cli/SQUAD.md
deliberation:
  enabled: true
  channel: "#squad-cli"
  default_timeout: 15  # minutes

  # What requires deliberation
  rules:
    pr:
      threshold: 20  # lines changed
      timeout: 15
    api_call:
      enabled: true
      timeout: 10
    spend:
      threshold: 0  # always deliberate
      requires_human: true
    cross_squad:
      timeout: 30

  # Who gets notified
  notify:
    - "@jorge"  # Always
    - security-critic  # For security-related
```

### Global Settings

```yaml
# .agents/config/deliberation.yaml
defaults:
  enabled: true
  timeout: 15

escalation:
  channel: "#escalations"
  auto_escalate_after: 60  # minutes with no resolution

decisions:
  channel: "#decisions"
  post_all: true  # Post all decisions for visibility
```

---

## Implementation Phases

### Phase 1: Intent Posting (Week 1)

- [ ] Add `deliberations` table
- [ ] Create `post_intent()` function
- [ ] Slack message formatting with buttons
- [ ] Basic timeout handling

**Deliverable:** Agents can post intents, humans see them

### Phase 2: Response Handling (Week 2)

- [ ] Handle button clicks (approve/reject)
- [ ] Handle thread replies
- [ ] Track participants
- [ ] Close deliberations on consensus/timeout

**Deliverable:** Full deliberation loop works

### Phase 3: Agent Integration (Week 3)

- [ ] `deliberate` tool for agents
- [ ] Update agent prompts
- [ ] Hook into execution flow
- [ ] Cross-squad mentions

**Deliverable:** Agents use deliberation protocol

### Phase 4: Polish (Week 4)

- [ ] #decisions digest channel
- [ ] Escalation auto-routing
- [ ] Analytics (decision velocity, participation)
- [ ] Mobile notification tuning

**Deliverable:** Production-ready system

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Deliberation → Decision time | <20 min (P50) |
| Human participation rate | >30% of deliberations |
| Objection rate | 10-20% (too low = rubber stamp) |
| Post-decision reversals | <5% |
| Agent-to-agent consultations | >50% of deliberations |

---

## Open Questions

1. **Token cost** - Agents reading Slack threads adds context. Cache aggressively?
2. **Thread length** - Long discussions = expensive. Summarize after N messages?
3. **Async agent responses** - Agent not running when mentioned. Queue for next run?
4. **Multi-tenant** - Each tenant gets own channels? Channel naming conventions?

---

## References

- Existing Slack worker: `squads-scheduler/slack_worker.py`
- Brief actions table: `alembic/versions/018_slack_actions.py`
- Agent execution flow: `squads-scheduler/scheduler.py`
