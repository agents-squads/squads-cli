# SQUAD.md schema

A squad is defined by typed frontmatter in four blocks rather than prose. The
definition is [`schemas/squad.schema.json`](../schemas/squad.schema.json)
(JSON Schema, shipped in the npm package). `squads contract validate` checks
every SQUAD.md against it.

> **Status: format draft.** The runtime still reads the current fields (`repo`,
> `context.model`, `context.budget`, `depends_on`, …). Keep them until the
> runtime reads the four blocks. Until then `contract validate` reports where
> each one will go as a hint, and hints never fail.

| Block | Holds |
|---|---|
| `cost` | `budget` (`daily_usd`, `weekly_usd`, `per_run_usd`), `models` (`default`, `expensive`, `cheap`), `lanes`: provider lanes in order of preference |
| `behavior` | `permissions`, `extra_tools`, `approval`: actions that need a human decision first, `cooldown_s` |
| `context` | `agents_md`: the AGENTS.md that says how to work in the repo, `mcp`, `skills`, `memory.load`, `exclude`: paths never loaded |
| `org` | `owner`: the accountable human (required), `members`, `domain`, `repos`, `paths`, `depends_on`, `goals`: each `goal` with the `check` that verifies it |

```yaml
---
name: web
mission: Ship the marketing site.
status: active            # active | paused
cost:
  budget: { daily_usd: 5, per_run_usd: 1 }
  models: { default: sonnet, cheap: haiku }
  lanes: [deepseek, claude]
behavior:
  approval: [merge, publish]
context:
  agents_md: AGENTS.md
  exclude: ["dist/**"]
org:
  owner: maria
  members: [lead, writer]
  repos: [acme/acme-web]
  goals:
    - goal: Homepage LCP under 2s
      check: npm run lighthouse -- --assert lcp<2000
---
```

Editors with YAML language support can validate while you type. Point them at
`node_modules/squads-cli/schemas/squad.schema.json`.

## What fails

`contract validate` exits non-zero when one of these blocks holds something the
schema doesn't allow: a wrong type, a negative budget, an unknown key inside a
block, a goal without a check, or an `org` without an `owner`. It also fails
when `status` is anything but `active` or `paused` (`frozen` is accepted as a
legacy spelling, with a hint to use `paused`). Unknown top-level keys are hints.
