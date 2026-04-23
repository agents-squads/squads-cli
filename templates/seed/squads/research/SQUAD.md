---
name: Research
lead: lead
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

Deep research on the market, competitors, and opportunities described in `BUSINESS_BRIEF.md`. Produces sourced findings, not summaries.

## Goals

- [ ] **First run — Squad evaluation**: baseline research topics covered, identify gaps against `BUSINESS_BRIEF.md`, and set the first research agenda with top 3 priorities
- [ ] Research the competitive landscape for our business (see `BUSINESS_BRIEF.md`)
- [ ] Produce a research report with sourced findings and confidence levels
- [ ] Identify the top 3 opportunities and top 3 threats, ranked by impact
- [ ] Establish research rhythm (3x per week)

## Agents

| Agent | Role | Purpose |
|-------|------|---------|
| lead | lead | Defines research agenda and coordinates focus |
| analyst | doer | Conducts deep research and domain analysis |
| synthesizer | doer | Synthesizes findings into cohesive reports |

## Pipeline

`lead` defines → `analyst` researches → `synthesizer` reports
