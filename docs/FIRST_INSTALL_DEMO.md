# Squads CLI - First Time Install Demo

**Quick visual guide showing what to expect when installing squads-cli for the first time.**

---

## Step 1: Install globally

```bash
$ npm install -g squads-cli
```

**Output:**
```
added 42 packages in 3s

8 packages are looking for funding
  run `npm fund` for details
✓ squads-cli installed successfully
```

---

## Step 2: Initialize in your project

```bash
$ squads init
```

**Output:**
```
  squads init

  ✓ Created .agents/squads/ directory
  ✓ Created example squad: engineering
  ✓ Created .agents/memory/ directory
  ✓ Created .agents/sessions/ directory

  Next steps:
  $ squads status     See your new squad
  $ squads dash       Full dashboard view
```

**What was created:**
```
.agents/
├── squads/
│   └── engineering/
│       ├── SQUAD.md              # Squad configuration
│       ├── backend-engineer.md   # Example agent
│       ├── frontend-engineer.md  # Example agent
│       └── devops-engineer.md    # Example agent
├── memory/
│   └── engineering/
│       └── .gitkeep
└── sessions/
    ├── active/
    └── history.jsonl
```

---

## Step 3: Check status

```bash
$ squads status
```

**Output:**
```
  squads status
  ● 0 active sessions

  1/1 squads  │  memory: enabled

  ┌────────────────────────────────────────────────────────┐
  │ SQUAD           AGENTS  MEMORY        ACTIVITY         │
  ├────────────────────────────────────────────────────────┤
  │ engineering     3       none          —                │
  └────────────────────────────────────────────────────────┘

  $ squads status <squad>    Squad details
  $ squads dash              Full dashboard
  $ squads run <squad>       Execute a squad
```

---

## Step 4: View full dashboard

```bash
$ squads dash
```

**Output:**
```
  squads dashboard
  ● 0 active sessions

  1/1 squads  │  0 commits

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 0% goal progress

  ┌──────────────────────────────────────────────────────────┐
  │ SQUAD        COMMITS PRs ISSUES GOALS  PROGRESS          │
  ├──────────────────────────────────────────────────────────┤
  │ engineering  0       0   0/0    0/0    ━━━━━━━━          │
  └──────────────────────────────────────────────────────────┘

  Git Activity (30d)
  Last 14d: ▁▁▁▁▁▁▁▁▁▁▁▁▁▁
  0 commits  │  0/day  │  0 active days

  Goals
  No goals set yet

  $ squads goal set <squad> "<goal>"    Set a goal
  $ squads run <squad>                  Execute a squad
```

---

## Step 5: Set your first goal

```bash
$ squads goal set engineering "Ship authentication feature by Friday"
```

**Output:**
```
  ● Goal added to engineering
  Ship authentication feature by Friday
```

**Verify:**
```bash
$ squads goal list
```

**Output:**
```
  squads goals

  ┌─────────────────────────────────────────────────────────┐
  │ SQUAD        STATUS    GOAL                             │
  ├─────────────────────────────────────────────────────────┤
  │ engineering  pending   Ship authentication feature...   │
  └─────────────────────────────────────────────────────────┘

  $ squads goal progress <squad>     Update progress
  $ squads goal complete <squad>     Mark as complete
```

---

## Step 6: Query memory (semantic search)

```bash
$ squads memory query "authentication"
```

**Output:**
```
  squads memory query "authentication"

  0 results found

  Memory will be populated as agents run and update their state.

  $ squads memory show <squad>       View squad memory
  $ squads memory update <squad>     Update squad memory
```

---

## Step 7: View squad details

```bash
$ squads status engineering -v
```

**Output:**
```
  squads status engineering

  Build, deploy, and maintain software systems.

  Agents (3)

  ┌────────────────────────────────────────────────────────────────┐
  │ ○ backend-engineer       Agent in engineering                  │
  │ ○ frontend-engineer      Agent in engineering                  │
  │ ○ devops-engineer        Agent in engineering                  │
  └────────────────────────────────────────────────────────────────┘

  Memory (none)

  Goals (1)
  ● Ship authentication feature by Friday

  $ squads run engineering           Run the squad
  $ squads memory show engineering   View full memory
  $ squads status engineering -v     Verbose status
```

---

## Step 8: Run your first squad (optional)

```bash
$ squads run engineering
```

**What happens:**
1. Squad SQUAD.md is loaded
2. Agents are selected based on task/trigger
3. Each agent runs via Claude Code
4. Outputs are saved to designated repo
5. Memory is updated
6. Dashboard reflects activity

**Note**: Requires Claude Code CLI installed and configured.

---

## What's Next?

### Create More Squads
```bash
# Copy the engineering template
cp -r .agents/squads/engineering .agents/squads/marketing

# Edit SQUAD.md and agents to fit your domain
```

### Add Agents to Existing Squads
```bash
# Create new agent definition
touch .agents/squads/engineering/security-engineer.md

# Fill in: Purpose, Inputs, Outputs, Instructions
```

### Track Activity
```bash
# Daily check-in
squads dash

# CEO summary
squads dash --ceo

# Query memory across all squads
squads memory query "bugs"

# Update goal progress
squads goal progress engineering
```

### Advanced Features

**Smart Triggers** (Pro):
```yaml
# In SQUAD.md
triggers:
  - name: high-priority-bug
    agent: bug-fixer
    condition: "SELECT COUNT(*) > 0 FROM issues WHERE priority='critical'"
    cooldown: 1 hour
```

**Memory Sync** (Pro):
```bash
# Sync memory to cloud
squads memory sync

# Pull latest from team
squads memory pull
```

---

## Requirements

- **Node.js** 18+
- **Git** (for activity tracking)
- **Claude Code** (for running agents)
- **GitHub CLI** (optional, for PR/issue metrics)

---

## Support

- **Docs**: [github.com/agents-squads/squads-cli](https://github.com/agents-squads/squads-cli)
- **Issues**: [github.com/agents-squads/squads-cli/issues](https://github.com/agents-squads/squads-cli/issues)
- **Website**: [agents-squads.com](https://agents-squads.com)

---

**That's it! You're ready to organize and run autonomous AI agents with squads-cli.** 🚀
