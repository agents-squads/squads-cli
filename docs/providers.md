# Providers

Multi-provider support isn't just a feature — it's central to how squads
work. Different models have different strengths, costs, and speed
profiles. A squad can route its scanner to a fast, cheap model (Gemini
Flash) for high-volume monitoring, its worker to a deep reasoning model
(Claude Opus) for complex analysis, and its verifier to a mid-tier model
for cost-effective quality checks.

Squads shells out to native AI CLIs. Each provider's CLI handles auth,
context, and tool use independently — Squads just orchestrates.

| Provider | CLI | Status |
|----------|-----|--------|
| Anthropic | `claude` | Stable — primary provider |
| Google | `gemini` | Stable |
| DeepSeek | `aider` (delegation) | New in 0.8.0 — file-based roles |
| OpenCode | `opencode` (native) | New — file-based executor |
| OpenAI | `codex` | Experimental |
| Mistral | `vibe` | Experimental |
| xAI | `grok` | Experimental |
| Ollama | `ollama` | Experimental |

Experimental providers have CLI integration but haven't been extensively
tested in production. Contributions welcome — especially from teams
already using these CLIs for autonomous work.

```bash
squads run research --provider=google --model=gemini-2.5-flash
squads providers    # List available providers and install status
```

## Choosing a provider per agent

Set the provider in an agent's frontmatter — mixed-provider squads work
out of the box:

```yaml
---
role: "scanner"
provider: "deepseek"
model: "deepseek-chat"
---
```

Precedence: agent frontmatter → `--provider` flag → squad
`providers.default`.

## File-based executors

Some providers (DeepSeek via `aider`, and `opencode` directly) run as
*file-based executors*: they read and edit files and commit the result,
but don't run shell commands or browse the web. They're a fit for
validators, formatters, and summarizers — agents whose job is read files
→ write files. Squads harvests their output from the isolated execution
worktree, so completed work is never lost even if the run ends
abnormally.

Every provider run is recorded in observability (`squads exec list`,
`squads usage`) with real token and cost figures parsed from the
executor's output.
