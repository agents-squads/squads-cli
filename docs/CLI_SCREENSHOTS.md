# Squads CLI - Visual Guide

**Real terminal output showing squads-cli in action.**

---

## Overview: `squads status`

Shows all squads with agents, memory, and activity.

```
$ squads status

  squads status
  ● 7 active sessions across 1 squad (claude 7)

  11/11 squads  │  memory: enabled

  ┌────────────────────────────────────────────────────────┐
  │ SQUAD           AGENTS  MEMORY        ACTIVITY         │
  ├────────────────────────────────────────────────────────┤
  │ analytics       1       none          —                │
  │ cli             8       3 entries     today            │
  │ company         2       1 entry       yesterday        │
  │ customer        4       3 entries     today            │
  │ engineering     6       1 entry       today            │
  │ finance         2       1 entry       3d ago           │
  │ intelligence    24      1 entry       today            │
  │ marketing       4       2 entries     2d ago           │
  │ product         2       1 entry       today            │
  │ research        6       1 entry       7d ago           │
  │ website         10      1 entry       today            │
  └────────────────────────────────────────────────────────┘

  $ squads status <squad>    Squad details
  $ squads dash              Full dashboard
  $ squads run <squad>       Execute a squad
```

**Key info:**
- Active Claude Code sessions detected
- 11 squads configured
- Memory enabled across all squads
- Recent activity timestamps

---

## Full Dashboard: `squads dash`

Comprehensive metrics across all squads.

```
$ squads dash

  squads dashboard
  ● 7 active sessions across 1 squad (claude 7)

  7/11 squads  │  511 commits  │  use -f for PRs/issues

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 30% goal progress

  ┌──────────────────────────────────────────────────────────┐
  │ SQUAD        COMMITS  PRs  ISSUES  GOALS  PROGRESS       │
  ├──────────────────────────────────────────────────────────┤
  │ engineering  224      0    0/0     1/1    ━━━━━━━━       │
  │ marketing    222      0    0/0     3/11   ━━━━━━━━       │
  │ website      222      0    0/0     1/1    ━━━━━━━━       │
  │ company      137      0    0/0     0/1    ━━━━━━━━       │
  │ cli          96       0    0/0     1/3    ━━━━━━━━       │
  │ product      96       0    0/0     0/1    ━━━━━━━━       │
  │ research     14       0    0/0     0/1    ━━━━━━━━       │
  │ intelligence 13       0    0/0     0/7    ━━━━━━━━       │
  │ customer     4        0    0/0     0/2    ━━━━━━━━       │
  │ finance      4        0    0/0     1/2    ━━━━━━━━       │
  │ analytics    0        0    0/0     0/0    ━━━━━━━━       │
  └──────────────────────────────────────────────────────────┘

  Git Activity (30d)

  Last 14d: ▁▁▁▁▁▁▄▆▄▆▅█▄▆▇

  511 commits  │  17/day  │  21 active days  │  66 peak (2026-01-03)

  agents-squads-web   ━━━━━━━━━━━━ 222
  hq                  ━━━━━━━━━━━━ 128
  squads-cli          ━━━━━━━━━━━━ 96
  research            ━━━━━━━━━━━━ 14
  intelligence        ━━━━━━━━━━━━ 13

  By author: Jorge Vidaurre 510  │  Agents Squads 1

  Token Economics

  ○ Plan not configured

  Set your Claude plan:
  $ export SQUADS_PLAN_TYPE=max   # $200/mo flat
  $ export SQUADS_PLAN_TYPE=usage # pay-per-token

  Today
  2.0M tokens  │  3246 calls  │  $207.15
  Week   9.2M tokens  │  12702 calls  │  $758.25

  Efficiency
  287k tokens/goal  │  7 goals done

  Rate Limits (Tier 0)
  RPM  ━━━━━━━━━━ 2.6/4000
  TPM  ━━━━━━━━━━ 2k/480k
  ● Capacity for autonomous triggers

  Infrastructure (redis)

  ● postgres  ● redis  ● otel

  Today: 3246 calls  $207.15/$50  1.3M+663k tokens
  Models: opus 1619  sonnet 154  haiku 1473
  Week:  12702 calls  $758.25  opus $738  haiku $11  sonnet $9

  Goals

  ◇ cli Add `squads baseline` command for before/after …
  ◇ cli Improve dashboard with cost projections
  ◇ company Generate first consulting revenue
  ◇ customer Identify 10 qualified leads
  ◇ customer Contact 5 HOT leads by Jan 10: Cursor, Sierra, …
  ◇ finance Define consulting pricing tiers
    +17 more

  $ squads run <squad>    Execute a squad
  $ squads goal set       Add a goal
```

**Features shown:**
- Goal progress tracking
- Git activity sparklines
- Token economics & costs
- Rate limits monitoring
- Infrastructure status
- Active goals preview

---

## Squad Details: `squads status intelligence`

Drill down into a specific squad.

```
$ squads status intelligence

  Gather intelligence that drives business decisions — competitive
  landscape, market dynamics, and enterprise adoption patterns.

  Agents (24)

  ┌────────────────────────────────────────────────────────────────┐
  │ ○ ANALYTICS_ROADMAP                                            │
  │ ○ agent-frameworks-monitor                                     │
  │ ○ anthropic-monitor                                            │
  │ ○ data-architect                                               │
  │ ○ databricks-monitor                                           │
  │ ○ dbt-monitor                                                  │
  │ ○ decision-mapper                                              │
  │ ○ enterprise-ai-monitor                                        │
  │ ○ industry-scanner                                             │
  │ ○ insights-costs                                               │
  │ ○ insights-daily                                               │
  │ ○ insights-problems                                            │
  │ ○ insights-recommend                                           │
  │ ○ intel-critic                                                 │
  │ ○ intel-lead                                                   │
  │ ○ lead-scorer                                                  │
  │ ○ looker-monitor                                               │
  │ ○ market-discovery                                             │
  │ ○ network-scanner                                              │
  │ ○ npm-intelligence                                             │
  │ ○ omni-monitor                                                 │
  │ ○ signal-hunter                                                │
  │ ○ snowflake-monitor                                            │
  │ ○ tableau-monitor                                              │
  └────────────────────────────────────────────────────────────────┘

  Memory (1 entry)

  ◆ intel-lead
    └ updated: 2026-01-06

  $ squads run intelligence           Run the squad
  $ squads memory show intelligence   View full memory
  $ squads status intelligence -v     Verbose status
```

**Shows:**
- Squad mission
- All agents (24 in intelligence)
- Memory entries
- Next actions

---

## Goals: `squads goal list`

Track objectives across all squads.

```
$ squads goal list

  cli
  Build and maintain the Squads CLI…

  ● [2] Add `squads baseline` command for before/after metrics
  ● [3] Improve dashboard with cost projections

  company
  Maintain company strategy, mission…

  ● [1] Generate first consulting revenue

  customer
  Manage customer relationships…

  ● [1] Identify 10 qualified leads
  ● [2] Contact 5 HOT leads by Jan 10: Cursor, Sierra, Distyl…

  finance
  Track financial metrics…

  ● [2] Define consulting pricing tiers

  intelligence
  Gather intelligence that drives business decisions…

  ● [1] **Phase 1** (Week 1): Minimum Viable Insights
  ● [2] **Phase 2** (Week 2): dbt semantic layer foundation
  ● [3] **Phase 3** (Week 3): `squads explore` interface
  ● [4] **Phase 4** (Week 4): Proactive insights
  ● [5] **Phase 5** (Week 5+): Advanced analytics
  ● [6] Weekly market brief for website content
  ● [7] Phase 1: Build Minimum Viable Insights by end of week

  marketing
  Own the funnel: Awareness → Consideration → Conversion…

  ● [3] Define weekly/monthly targets for each stage
  ● [4] Create content calendar aligned to funnel stages
  ● [5] Establish baseline metrics for Awareness
  ● [6] Track Consideration signals
  ● [7] Drive Conversion
  ● [8] Rank #1 for 'agents squads' on Google
  ● [9] Publish 4 SEO-optimized blog posts per month
  ● [10] Get 10 backlinks from AI/tech blogs

  product
  Build AI agent tools and platforms…

  ● [1] Publish squads-cli to npm

  research
  Advance understanding of autonomous AI systems…

  ● [1] Publish first research insight

  23 active  │  7 completed
```

**Goal tracking:**
- Organized by squad
- Numbered for reference
- Progress indicators
- Active vs completed count

---

## Memory Search: `squads memory query "analytics"`

Semantic search across all squad memory.

```
$ squads memory query "analytics"

  5 results found

  ┌──────────────────────────────────────────────────┐
  │ LOCATION                    TYPE      SCORE      │
  ├──────────────────────────────────────────────────┤
  │ intelligence/intel-lead     state     7.2        │
  │ marketing/marketing-lead    state     7.2        │
  │ product/product-lead        state     7.2        │
  │ website/web-lead            state     7.2        │
  │ intelligence/intel-lead     output    6.0        │
  └──────────────────────────────────────────────────┘

  Matches

  ◇ | Claude Code | 2026-01-04 | 80.9% SWE-bench score…
    └ intelligence/intel-lead
  ◇ - feat(intelligence): analytics roadmap - "Looker for Claud…
    └ intelligence/intel-lead
  ◇ ## Analytics Access Audit (2025-12-30)
    └ marketing/marketing-lead
  ◇ | **Google Analytics 4** | Configured | GA ID: `G-HWW8LJHMD…
    └ marketing/marketing-lead
  ◇ - feat(analytics): Add CLI telemetry KPIs and first report
    └ product/product-lead
  ◇ - Analytics: GA4 with custom event tracking
    └ website/web-lead
  ◇ 4. **Enterprise-grade is the bar** - Fortune 500 adoption o…
    └ intelligence/intel-lead

  $ squads memory show <squad>   View full memory
```

**Memory features:**
- Semantic search (not keyword matching)
- Relevance scoring
- Context snippets
- Source attribution

---

## Use These Screenshots

**For PRs:**
1. Copy output blocks into PR descriptions
2. GitHub renders them with syntax highlighting
3. Shows before/after state

**For Documentation:**
- README.md examples
- Website demo sections
- Blog post tutorials

**For Social Media:**
- Terminal.sexy - convert to PNG
- Carbon - make it beautiful
- Share on X/LinkedIn

---

## Automation Opportunity

**Future**: Auto-capture CLI output on PR creation

```yaml
# .github/workflows/pr-screenshots.yml
name: Capture CLI Demos
on: pull_request

jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - run: npm install -g squads-cli
      - run: squads status > demo-output.txt
      - uses: actions/upload-artifact@v2
        with:
          name: cli-demo
          path: demo-output.txt
```

---

**These are real outputs from a production system running 11 squads, 69 agents, and handling $758/week in AI costs.**
