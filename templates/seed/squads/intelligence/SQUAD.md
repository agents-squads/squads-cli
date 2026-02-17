---
name: Intelligence
lead: intel-lead
channel: "#intelligence"
model: sonnet
effort: high
schedule: "0 9 * * 1-5"
approvals:
  policy:
    auto:
      - memory.update
      - agent.run.readonly
    approve:
      - agent.run.write
---

# Intelligence Squad

Strategic synthesis. Turns raw information into what you know, what you don't know, and what to do next.

## Goals

- [ ] Produce first Know / Don't Know / Playbook brief
- [ ] Identify top 3 blind spots in current strategy
- [ ] Establish intelligence rhythm (daily weekdays)

## Agents

| Agent | Role | Purpose |
|-------|------|---------|
| intel-lead | lead | Synthesizes all inputs into Know / Don't Know / Playbook |
| intel-eval | evaluator | Evaluates brief quality, source rigor, actionability |
| intel-critic | critic | Challenges assumptions, finds missing perspectives |

## Pipeline

`intel-lead` synthesizes → `intel-eval` scores → `intel-critic` challenges → `intel-lead` refines
