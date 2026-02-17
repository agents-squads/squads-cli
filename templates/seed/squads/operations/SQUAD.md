---
name: Operations
lead: ops-lead
channel: "#operations"
model: sonnet
effort: medium
schedule: "0 9 * * 1-5"
approvals:
  policy:
    auto:
      - memory.update
      - goal.set
      - agent.run.readonly
    approve:
      - agent.run.write
      - trigger.fire
    confirm:
      - deploy.production
      - budget.override
  thresholds:
    spend: 25
    bulk_actions: 5
---

# Operations

Runs the business. Tracks goals, manages finances, and ensures the organization operates smoothly.

## Goals

- [ ] Establish daily operational rhythm
- [ ] Track business objectives and KPIs
- [ ] Monitor financial health (revenue, expenses, runway)

## Agents

| Agent | Role | Purpose |
|-------|------|---------|
| ops-lead | lead | Daily operations, squad coordination, founder briefings |
| finance-tracker | doer | Tracks revenue, expenses, runway, and invoicing |
| goal-tracker | evaluator | Monitors goal progress and flags at-risk objectives |

## Pipeline

`ops-lead` coordinates → `finance-tracker` tracks money → `goal-tracker` measures progress
