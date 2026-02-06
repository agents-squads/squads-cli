---
name: Research
lead: researcher
channel: "#research"
model: sonnet
effort: high
schedule: "0 10 * * 1,3,5"
approvals:
  policy:
    auto:
      - memory.update
      - agent.run.readonly
    approve:
      - agent.run.write
---

# Research Squad

Market, competitor, and trend research. Produces actionable intelligence.

## Goals

- [ ] Identify market landscape and key competitors
- [ ] Produce initial research report
- [ ] Establish research rhythm (3x per week)

## Agents

| Agent | Role | Purpose |
|-------|------|---------|
| researcher | lead | Market, competitor, trend research |
| analyst | doer | Synthesizes research into actionable insights |
| research-eval | evaluator | Evaluates research quality and relevance |
| research-critic | critic | Critiques methodology and coverage gaps |

## Pipeline

`researcher` gathers → `analyst` synthesizes → `research-eval` scores → `research-critic` improves
