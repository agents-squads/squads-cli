# Execution events: redaction and sensitivity

Every execution event passes through `ExecEventWriter.emit()` (`src/lib/exec-events.ts`) before it is written
to `.agents/observability/events/<run>.jsonl` or flushed to the API. That single point applies the rules below,
so the file and the API always carry the same line. Events are **sensitive by default** (framework spec §10.7).

## Redaction (at write time)

Every string in an event is redacted, identifiers included, since a value can ride in a tool or model name.
Only `type`, `startedAt` and `sha256` are left alone. Text longer than 32 KB is cut before matching, and every
pattern has a bounded prefix, so no input makes redaction slow. Redaction never throws into a run: an event
that can't be redacted is dropped and a `truncated` marker is written instead. It is never written raw.

Two kinds of masking apply, in this order, and each match becomes `[redacted:<kind>]`:

1. **Known values** (`known`): exact matches of 8 or more characters, each also in its JSON-escaped and
   URL-encoded form. The list is reloaded when the store directory changes.
   - From each regular file in the local secret store (`~/.squads/secrets/`, or `SQUADS_SECRETS_DIR`). For JSON
     files only fields whose name says key, secret, token, pass, pwd, private, credential, pem or auth count;
     other files count whole and line by line. Links and files over 256 KB are skipped.
   - From environment variables whose name says API key, token, secret, password, credential, private key or
     access key.
2. **Patterns** (`REDACT_PATTERNS` in `src/lib/event-redact.ts`; a server should re-apply them on ingest):
   - `private-key`: any PEM or PGP private-key block (RSA, EC, OPENSSH, ENCRYPTED, PGP … BLOCK), including one
     cut before its END line
   - the commit scanner's shapes (`src/lib/secret-scan.ts`): `anthropic-key`, `openai-key`, `github-token`,
     `github-pat`, `slack-token`, `aws-access-key`, `google-api-key`, `stripe-key`, `chilean-rut`
   - token shapes: `api-key` (`sk-…`), `gitlab-token` (`glpat-`), `npm-token` (`npm_`), `huggingface-token`
     (`hf_`), `sendgrid-key` (`SG.`), `pypi-token` (`pypi-`), `jwt`
   - `url-credential`: the password in `scheme://user:password@host`
   - `authorization`: the credential after `Authorization:`, with any scheme (Bearer, token, Basic, Digest);
     `bearer`: the token after `Bearer `
   - `flag`: `--password X`, `--token=X` and the like, and `-pSECRET` (mysql style)
   - `query`: the value of `key`, `sig`, `signature`, `code`, `token`, `access_token`, `api_key` and `password`
     in a query string
   - `assigned`: the value in `key=value` or `key: value` when the key names a password, pass, pwd, secret,
     token, API key, access key, private key, auth or credential. References (`$VAR`, `$(…)`, `process.env.X`,
     `<placeholder>`) are kept.
   - `chilean-rut`: also without dots (`12345678-5`)

Known gap: a private key split across two events is masked in the first event but not in the second, unless
the key is in the secret store (where its lines are known values).

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

## Messages, running usage and run titles

- **`message` `{ role, text }`**: what the agent said, from the Claude and opencode adapters. The local file
  keeps the text whole (redacted); the API flush cuts it to 200 characters. Sensitivity is `moderate`, or `high`
  when redaction fired.
- **`usage_running` `{ input, output, cacheRead, cacheWrite, costEst, model }`**: running totals while a run
  goes, for live views, which take the **latest** per run. `token_usage` stays one terminal event per agent,
  because readers sum it per agent (`context-report`); emitting running totals as `token_usage` would
  double-count.
  - Claude: summed over API messages, using each message's latest usage. Stream-json repeats a message once per
    content block, and the repeats are not counted twice.
  - opencode: one per step; the last step is followed by `token_usage`.
  - Providers that report output tokens only in the final result (DeepSeek through Claude Code) show
    `output: 0` until `token_usage`. `costEst` is 0 for Claude.
- **`run_start.title` and `run_start.task`**:
  - `title` is the task's first line (at most 100 characters). A task that is only an issue reference
    (`Work owner/repo#12`) is titled with that issue's title, via `gh` with a 4-second limit, falling back to
    the task.
  - `task` is the full task, redacted.
  - Both fields are additive. `run_start` is `low` without a task and `moderate` with one.
