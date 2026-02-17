---
name: Marketing
lead: content-drafter
channel: "#marketing"
model: sonnet
effort: medium
schedule: "0 9 * * 1,3,5"
approvals:
  policy:
    auto:
      - memory.update
      - goal.set
      - content.draft
      - agent.run.readonly
    approve:
      - content.schedule
      - agent.run.write
    confirm:
      - social.post
      - blog.publish
      - email.send
  thresholds:
    spend: 10
    posts_per_day: 3
---

# Marketing

Grows your audience. Creates content, manages social presence, and tracks growth metrics.

## Goals

- [ ] Establish content creation rhythm
- [ ] Build social media presence
- [ ] Track and improve engagement metrics

## Agents

| Agent | Role | Purpose |
|-------|------|---------|
| content-drafter | lead | Creates blog posts, social content, and marketing copy |
| social-poster | doer | Manages social media posting schedule and engagement |
| growth-analyst | evaluator | Tracks metrics, identifies what's working, suggests improvements |

## Pipeline

`content-drafter` creates → `social-poster` distributes → `growth-analyst` measures
