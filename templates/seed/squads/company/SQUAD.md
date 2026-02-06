---
name: Company Operations
lead: manager
channel: "#company"
model: sonnet
effort: high
schedule: "0 9 * * 1-5"
approvals:
  policy:
    auto:
      - memory.update
      - goal.set
      - agent.run.readonly
    approve:
      - trigger.fire
      - agent.run.write
      - pr.merge
    confirm:
      - deploy.production
      - budget.override
  thresholds:
    spend: 50
    bulk_actions: 5
    files_changed: 20
---

# Company Operations

Manages the AI workforce. The manager agent orchestrates all squads, coordinates leads, and runs daily operations.

## Goals

- [ ] Understand business context and set up initial squads
- [ ] Establish daily operational rhythm
- [ ] Track and report on business objectives

## Agents

| Agent | Role | Purpose |
|-------|------|---------|
| manager | lead | Orchestrates squads, coordinates work, daily operations |
| event-dispatcher | doer | Monitors events, dispatches to relevant squads |
| goal-tracker | doer | Tracks business objectives, updates progress |
| company-eval | evaluator | Evaluates squad outputs and business impact |
| company-critic | critic | Critiques process, identifies improvements |

## Pipeline

`manager` → dispatches to squads → `company-eval` scores → `company-critic` improves
