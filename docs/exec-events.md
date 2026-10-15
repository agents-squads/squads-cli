# Execution events: redaction and sensitivity

Every execution event passes through `ExecEventWriter.emit()` (`src/lib/exec-events.ts`) before it is written
to `.agents/observability/events/<run>.jsonl` or flushed to the API. That single point applies the rules below,
so the file and the API always carry the same line. Events are **sensitive by default** (framework spec §10.7).

## Redaction (at write time)

Every free-text field of an event is redacted. Structural fields are left alone: `type`, `kind`, `tool`,
`model`, `mode`, `role`, `squad`, `agent`, `childRunId`, `startedAt` and `sha256`.

Two kinds of masking apply, in this order, and each match becomes `[redacted:<kind>]`:

1. **Known values** (`known`): exact matches of 12 or more characters.
   - From each regular file in the local secret store (`~/.squads/secrets/`, or `SQUADS_SECRETS_DIR`). For JSON
     files only fields whose name says key, secret, token, password, private or credential count; other files
     count whole and line by line. Links and files over 256 KB are skipped.
   - From environment variables whose name says API key, token, secret, password, credential, private key or
     access key.
2. **Patterns** (`REDACT_PATTERNS` in `src/lib/event-redact.ts`; a server should re-apply them on ingest):
   - `private-key`: a PEM private-key block, including one cut before its END line
   - the commit scanner's shapes (`src/lib/secret-scan.ts`): `anthropic-key`, `openai-key`, `github-token`,
     `github-pat`, `slack-token`, `aws-access-key`, `google-api-key`, `stripe-key`, `chilean-rut`
   - `api-key`: `sk-` followed by 16 or more token characters
   - `jwt`: three dot-separated base64url segments starting with `eyJ`
   - `bearer`: the token after `Bearer `
   - `assigned`: the value in `key=value` or `key: value` when the key names a password, secret, token, API key,
     access key or private key. References (`$VAR`, `$(…)`, `process.env.X`, `<placeholder>`) are kept.

Text is redacted first and cut second: `summary`, `inputSummary`, `ref`, `task` and `url` are cut to 200
characters after redaction, so a secret that straddles the cut leaves no fragment behind.

## What tool events keep

- `tool_call.inputSummary` keeps one allowlisted input value (`command`, `file_path`/`filePath`,
  `notebook_path`, `pattern`, `query`, `url`), redacted. For any other input it keeps only the field names,
  e.g. `{customer, amount}`.
- `tool_result` carries `chars` and `sha256` of the whole result, plus a redacted excerpt in `summary`. File
  tools that return content (`Read`, `Grep`, `NotebookRead`) keep size and hash only; their `summary` is empty.

## Sensitivity

Every persisted line carries `sensitivity`. The field is additive, so older readers ignore it.

| Value | Events |
|---|---|
| `low` | `run_start`, `context_assembled`, `token_usage`, `run_end`, `subagent_done`, `truncated`, `file_read`, `file_write` |
| `moderate` | everything carrying text or excerpts: `tool_call`, `tool_result`, `web_fetch`, `subagent_spawn`, `artifact` |
| `high` | any event in which redaction fired |
