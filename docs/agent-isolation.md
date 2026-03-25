# Agent Isolation Map

> Defines which agents run locally vs on cloud VMs to prevent file conflicts

## Principle

Each agent writes to its own directory: `.agents/memory/{squad}/{agent}/`

**Rule:** Same agent never runs on multiple machines simultaneously.

## Environment Split

### LOCAL (Your Machine)
Interactive work, code review, customer-facing tasks

| Squad | Agents | Reason |
|-------|--------|--------|
| **engineering** | eng-lead, issues-solver, problem-solver | Code changes need review |
| **cli** | cli-lead, all evaluators | CLI development |
| **website** | web-lead, issue-fixer | Website changes |
| **product** | product-lead, product-critic | Strategic decisions |
| **company** | orchestrator, company-critic | Company direction |
| **customer** | All | Customer-facing, sensitive |

### CLOUD VM (Autonomous)
Research, monitoring, batch processing - can run 24/7

| Squad | Agents | Reason |
|-------|--------|--------|
| **intelligence** | All 32 agents | Research, no code changes |
| **research** | All 15 agents | Deep research tasks |
| **analytics** | All 6 agents | Data analysis |
| **marketing** | content-publisher, linkedin-poster | Content generation |
| **growth** | seo-daily, backlink-hunter | Automated growth tasks |
| **finance** | monitors, reconcilers | Background monitoring |
| **data** | All 6 agents | Data processing |

## Overlap Prevention

```yaml
# .agents/config/isolation.yaml
environments:
  local:
    squads:
      - engineering
      - cli
      - website
      - product
      - company
      - customer

  cloud:
    squads:
      - intelligence
      - research
      - analytics
      - marketing/content-publisher
      - marketing/linkedin-poster
      - growth
      - finance
      - data
```

## Commands

```bash
# Local machine
squads run engineering --execute
squads run cli --parallel --execute

# Cloud VM (via SSH)
ssh squads-worker-1
squads run intelligence --parallel --execute
squads run research --parallel --execute
```

## Git Sync Protocol

Both machines work on `main` branch but write to different files:

1. **Before starting agents:** `git pull origin main`
2. **After agents complete:** `git add .agents/memory && git push`
3. **If conflict:** Agent isolation failed - check which agent ran on both

## Capacity Planning

| Environment | Agents | Est. Cost/Day |
|-------------|--------|---------------|
| Local (5 parallel) | ~30 | $150-200 (subscription) |
| Cloud VM (10 parallel) | ~50 | $300-400 (subscription) |
| **Total** | ~80 | $100/mo Max subscription |

## Scaling

To add more cloud capacity:

```bash
# Create additional VMs
gcloud compute instances create squads-worker-2 ...
gcloud compute instances create squads-worker-3 ...

# Assign different squads to each
# worker-1: intelligence, research
# worker-2: analytics, marketing, growth
# worker-3: finance, data
```
