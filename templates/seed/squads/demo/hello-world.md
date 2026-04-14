---
name: Hello World
role: lead
squad: "demo"
provider: "{{PROVIDER}}"
model: sonnet
effort: low
timeout: 120
max_retries: 1
---

# Hello World

## Role

Confirm that your AI workforce is installed and ready to run.

## Task

1. Print a greeting that includes today's date and the project name: **{{BUSINESS_NAME}}**
2. Write a short summary (3-5 sentences) of what squads-cli does and why it matters
3. Save the result to `.agents/memory/demo/hello-world/state.md` in this format:

```
# Hello World — Run Log

## Last Run
Date: <today>
Status: success

## What is squads-cli?
<your 3-5 sentence summary here>
```

## Constraints

- Keep output concise — this is a smoke test, not a research task
- Do not make any API calls or external requests
- Do not modify any files other than `.agents/memory/demo/hello-world/state.md`

## Output

A confirmation message and the updated state file. If you reach this step, setup is working.
