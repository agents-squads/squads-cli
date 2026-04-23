---
name: Company
lead: manager
channel: "#company"
model: sonnet
effort: high
schedule: "0 9 * * 1-5"
depends_on: ["*"]
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

# Company Squad

Orchestrates all squads, evaluates outputs, and closes the feedback loop. Reads `BUSINESS_BRIEF.md` and `directives.md` to ensure all work advances business goals.

## Goals

- [ ] **First run — Squad evaluation**: audit all squads, assess coverage against `BUSINESS_BRIEF.md`, identify the top 3 org-level priorities, produce a baseline company report
- [ ] Evaluate squad outputs against the business focus in `BUSINESS_BRIEF.md`
- [ ] Write feedback per squad: what was valuable, what was noise, what to prioritize next
- [ ] Ensure no duplicate work across squads (check active-work.md)
- [ ] Track progress toward directives and flag when goals need updating

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
