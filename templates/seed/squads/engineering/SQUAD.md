---
name: Engineering
lead: issue-solver
channel: "#engineering"
model: sonnet
effort: high
schedule: "0 9 * * 1-5"
approvals:
  policy:
    auto:
      - memory.update
      - goal.set
      - branch.create
      - pr.create
      - commit.push
      - agent.run.readonly
    approve:
      - pr.merge
      - trigger.fire
      - agent.run.write
    confirm:
      - deploy.production
  thresholds:
    spend: 25
    files_changed: 20
---

# Engineering

Ships code. Solves issues, reviews PRs, and maintains code quality.

## Goals

- [ ] Solve open GitHub issues with PRs
- [ ] Maintain code quality through adversarial review
- [ ] Keep test coverage high

## Agents

| Agent | Role | Purpose |
|-------|------|---------|
| issue-solver | lead | Reads open issues, creates PRs with fixes |
| code-reviewer | evaluator | Reviews PRs for quality, security, and correctness |
| test-writer | doer | Writes tests for untested code paths |

## Pipeline

`issue-solver` fixes → `code-reviewer` reviews → `test-writer` covers
