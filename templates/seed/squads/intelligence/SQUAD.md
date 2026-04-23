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

Strategic synthesis. Turns raw information into what you know, what you don't know, and what to do next — for the business described in `BUSINESS_BRIEF.md`.

## Goals

- [ ] **First run — Squad evaluation**: baseline what we know vs don't know from `BUSINESS_BRIEF.md`, map intelligence gaps, set the first Know/Don't Know/Playbook brief
- [ ] Produce a Know / Don't Know / Playbook brief for the business focus in `BUSINESS_BRIEF.md`
- [ ] Identify the top 3 blind spots — what we're assuming without evidence
- [ ] Map the competitive landscape with sourced facts, not opinions
- [ ] Establish intelligence rhythm (daily weekdays)

## Agents

| Agent | Role | Purpose |
|-------|------|---------|
| intel-lead | lead | Synthesizes all inputs into Know / Don't Know / Playbook |
| intel-eval | evaluator | Evaluates brief quality, source rigor, actionability |
| intel-critic | critic | Challenges assumptions, finds missing perspectives |

## Pipeline

`intel-lead` synthesizes → `intel-eval` scores → `intel-critic` challenges → `intel-lead` refines
