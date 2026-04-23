---
name: Product
lead: lead
channel: "#product"
model: sonnet
effort: high
schedule: "0 9 * * 1-5"
depends_on: [intelligence, research]
approvals:
  policy:
    auto:
      - memory.update
      - goal.set
      - agent.run.readonly
    approve:
      - trigger.fire
      - agent.run.write
---

# Product Squad

Turns intelligence and research insights into decisions about what to build, improve, or stop — aligned with the business goals in `BUSINESS_BRIEF.md`.

## Goals

- [ ] **First run — Squad evaluation**: audit current product state, user feedback, and backlog against `BUSINESS_BRIEF.md` — produce a baseline product report with top 3 opportunities
- [ ] Translate research findings into a prioritized list of opportunities
- [ ] Produce a product roadmap with clear rationale for each item
- [ ] Write specs for the top priority with acceptance criteria
- [ ] Identify what to NOT build (parked items) and why

## Agents

| Agent | Role | Purpose |
|-------|------|---------|
| lead | lead | Coordinates product strategy and prioritizes roadmap |
| scanner | doer | Monitors user feedback and competitive signals |
| worker | doer | Writes product specs and documentation |

## Pipeline

`scanner` monitors → `lead` prioritizes → `worker` specs
