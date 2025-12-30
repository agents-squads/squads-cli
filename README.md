# squads-cli

CLI for managing AI agent squads.

## Installation

```bash
npm install -g squads-cli
```

## Quick Start

```bash
# Initialize a new project
squads init

# List agents
squads list

# Run an agent
squads run example-agent
```

## Commands

| Command | Description |
|---------|-------------|
| `squads init` | Initialize a new squad project |
| `squads list` | List all agents |
| `squads run <agent>` | Run an agent |
| `squads status` | Show squad status |

## Project Structure

```
your-project/
├── .agents/
│   ├── squads/       # Agent definitions (.md files)
│   ├── memory/       # Agent state/memory
│   └── outputs/      # Agent outputs
└── CLAUDE.md         # Project instructions
```

## Agent Definition

Agents are defined in markdown files:

```markdown
# My Agent

## Purpose
What this agent does.

## Model
claude-sonnet-4

## Tools
- Read
- Write
- WebSearch

## Instructions
1. Step one
2. Step two

## Output
Expected output format.
```

## License

MIT
