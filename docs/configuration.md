# Configuration

Starter squads, building your own, customizing context layers, and secrets.

## Starter Squads

The first experience matters. Rather than shipping an empty framework and
asking you to figure out what to build, `squads init` ships with 4 squads
designed to deliver visible output from the very first run. These aren't
demo squads — they're the foundation of an operational AI workforce.

| Squad | What It Does | Agents |
|-------|-------------|--------|
| **intelligence** | Strategic synthesis — Know / Don't Know / Playbook briefs | intel-lead, intel-eval, intel-critic |
| **research** | Market, competitor, and trend research with sourced findings | lead, analyst, synthesizer |
| **product** | Roadmap, specs, user feedback synthesis | lead, scanner, worker |
| **company** | Orchestrates squads, evaluates outputs, closes the feedback loop | manager, evaluator, goal-tracker, event-dispatcher, critic |

**Intelligence + research** produce insights. **Product** turns insights
into roadmap. **Company** evaluates everything and writes feedback — which
agents read next cycle. The loop closes automatically.

Additional squads available as packs:

```bash
squads init --pack engineering    # Add engineering squad
squads init --pack marketing      # Add marketing squad
squads init --pack all            # All available squads
```

## Build Your Own

Squads are directories. Agents are markdown files. Bring your own skills,
tools, and CLIs — anything your agents can run in a terminal becomes part
of the squad.

```bash
squads add devops -d "Infrastructure and deployment automation"
```

This creates `squads/devops/SQUAD.md` and a lead agent. Add more agents
as `.md` files, define their roles, give them access to your CLIs
(`terraform`, `kubectl`, `aws`, `docker` — whatever they need), and run:

```bash
squads run devops --parallel
```

## Customizing Your Squads

Agents read context in layers — higher layers are stable, lower layers
change often. Update them in this order:

### 1. Business Brief (what you do)

Edit `.agents/BUSINESS_BRIEF.md` — every agent reads this before every run.
The more specific you are, the better agents perform.

```markdown
What does your business do? Who are your customers? What market?
What should agents research first? Who are your competitors?
```

### 2. Directives (what matters now)

Edit `.agents/memory/company/directives.md` — strategic overlay that
overrides squad-level goals when there's a conflict.

```markdown
What is the #1 priority right now? What metric are you optimizing?
What constraints apply? What should agents NOT do?
```

### 3. Squad Goals (what each team does)

Replace the generic goals in each `SQUAD.md` with goals specific to your
business:

```bash
squads goal set intelligence "Monitor competitor X's pricing weekly"
squads goal set research "Deep dive on Y market segment"
squads goal set product "Write spec for Z feature"
```

### 4. Priorities (what to do this week)

Create or edit `.agents/memory/{squad}/priorities.md` — operational focus
that changes frequently:

```markdown
- Fix issue #123 (blocking users)
- Research competitor's new feature launch
- Update roadmap based on last cycle's feedback
```

**Rule**: Goals are aspirational (stable). Priorities are operational
(updated frequently). Directives are strategic (updated less frequently).

### Agent Instructions

Each `.md` file in a squad defines an agent's behavior, output format,
and quality rules. The starter agents come with structured output formats
(tables, scoring rubrics, required sections) — modify these to match what
you actually need.

### System Protocol

`.agents/config/SYSTEM.md` contains immutable rules all agents follow —
git workflow, memory protocol, output standards. You rarely need to change
this, but you can customize it for your team's conventions.

## Secrets

Agents need API keys to execute. Squads reads secrets from a `.env` file
in your project root — the same pattern used by most Node.js and Python
projects. Each provider's CLI uses its own environment variable, so you
only need keys for the providers you actually use.

```bash
# .env — never commit this file
ANTHROPIC_API_KEY=sk-ant-...    # Required for Claude Code (default provider)
GEMINI_API_KEY=...               # Required for Gemini CLI
OPENAI_API_KEY=sk-...            # Required for Codex
GITHUB_TOKEN=ghp_...             # Recommended for gh CLI operations
```

`squads run` loads `.env` automatically before dispatching any agent.
If a required key is missing, the provider's CLI will report the error —
Squads doesn't mask or intercept auth failures. Add `.env` to your
`.gitignore` to keep secrets out of version control.
