---
name: Growth
lead: growth-lead
channel: "#growth"
model: sonnet
effort: medium
schedule: "0 9 * * 1,3,5"
depends_on: [marketing]
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
      - experiment.launch
      - budget.override
  thresholds:
    spend: 15
    experiments_per_week: 2
---

# Growth Squad

Owns the funnel. Measures acquisition, activation, retention, and revenue. Runs experiments to find what moves the needle — then doubles down on what works.

Distinct from marketing: marketing creates content, growth distributes + measures + experiments.

## Goals

- [ ] **First run — Squad evaluation**: audit acquisition / activation / retention / revenue funnel against `BUSINESS_BRIEF.md`, identify the biggest leak, propose the first experiment
- [ ] Establish a weekly growth metrics review (one leading indicator per funnel stage)
- [ ] Run one focused experiment per week — hypothesis, metric, ship, measure, decide
- [ ] Focus on ONE funnel stage at a time — fix the biggest leak before moving on

## Agents

| Agent | Role | Purpose |
|-------|------|---------|
| growth-lead | lead | Owns the funnel, prioritizes experiments, sets the weekly focus |
| funnel-analyst | doer | Measures AARRR metrics, identifies biggest leak, quantifies impact |
| experiment-runner | doer | Designs and runs experiments, tracks results against hypothesis |
| growth-critic | critic | Challenges vanity metrics, demands statistical rigor, kills bad ideas |

## Pipeline

`funnel-analyst` measures → `growth-lead` prioritizes → `experiment-runner` tests → `growth-critic` reviews → `growth-lead` decides next

## Constraints

- No vanity metrics. Every metric must tie to revenue or retention.
- Focus one funnel stage at a time. Fix before expanding.
- Hypotheses must be falsifiable and time-bounded.
- Kill losing experiments fast. Double down on winners.
