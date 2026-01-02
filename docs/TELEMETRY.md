# Squads CLI Telemetry Architecture

This document maps all telemetry data flowing through the squads infrastructure.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        DATA SOURCES                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Claude Code (OTel)              squads-cli (Local)             │
│  ├─ api_request events           ├─ cli.init                    │
│  │  └─ model, tokens, cost       ├─ cli.run                     │
│  ├─ tool_result events           ├─ cli.status                  │
│  │  └─ tool_name, duration       ├─ cli.dashboard               │
│  └─ session context              ├─ cli.error                   │
│     └─ squad, agent, user_id     └─ cli.* (all commands)        │
│                                                                  │
└───────────────┬─────────────────────────┬───────────────────────┘
                │                         │
                ▼                         ▼
┌───────────────────────────┐  ┌──────────────────────────────────┐
│ OTel Collector (4318)     │  │ Local Storage                    │
│ └─ Batch + Forward        │  │ ~/.squads-cli/                   │
└───────────────┬───────────┘  │ ├─ telemetry.json (config)       │
                │              │ └─ events.json (last 1000)       │
                ▼              └──────────────────────────────────┘
┌───────────────────────────────────────────────────────────────┐
│                     SQUADS BRIDGE (8080)                       │
├───────────────────────────────────────────────────────────────┤
│ Endpoints:                                                     │
│ ├─ POST /v1/logs         ← OTel logs (api_request, tool_result)│
│ ├─ POST /v1/metrics      ← OTel metrics                        │
│ ├─ POST /api/telemetry   ← CLI anonymous events                │
│ ├─ GET  /stats           → Real-time budget/costs              │
│ ├─ GET  /api/cost/summary → Cost breakdown for dashboard       │
│ ├─ POST /api/conversations → Memory capture                    │
│ └─ GET  /api/conversations/search → Full-text search           │
└───────────────┬───────────────────────────────────────────────┘
                │
     ┌──────────┼──────────┬──────────────────┐
     ▼          ▼          ▼                  ▼
┌─────────┐ ┌───────┐ ┌──────────┐  ┌──────────────┐
│PostgreSQL│ │ Redis │ │ Langfuse │  │ Engram/mem0  │
│ (primary)│ │(cache)│ │(optional)│  │  (optional)  │
└─────────┘ └───────┘ └──────────┘  └──────────────┘
```

## Data Sources

### 1. Claude Code (OpenTelemetry)

Claude Code sends telemetry via OTLP HTTP to port 4318.

**Event Types:**

| Event | Data | Purpose |
|-------|------|---------|
| `api_request` | model, tokens, cost, cache | Track LLM usage |
| `tool_result` | tool_name, duration, success | Track tool execution |

**Token Attributes:**
- `input_tokens` / `output_tokens` - Token counts
- `cache_read_tokens` - Cached input tokens
- `cache_creation_tokens` - New cache entries
- `cost_usd` - Computed cost

**Context Attributes:**
- `session.id` - Session identifier
- `user.id` - User identifier
- `squad` - Squad name
- `agent` - Agent name
- `model` - Model used

### 2. squads-cli (Anonymous Telemetry)

The CLI tracks usage locally with optional remote reporting.

**Configuration:**
```bash
# Disable telemetry
export SQUADS_TELEMETRY_DISABLED=1
# or
export DO_NOT_TRACK=1

# Custom endpoint
export SQUADS_TELEMETRY_URL=https://your-endpoint.com/telemetry
```

**Local Storage:**
- `~/.squads-cli/telemetry.json` - Anonymous ID and config
- `~/.squads-cli/events.json` - Last 1000 events

**Event Types:**

| Event | When | Properties |
|-------|------|------------|
| `cli.init` | Project initialized | template |
| `cli.run` | Squad/agent executed | squad, agent, durationMs |
| `cli.status` | Status viewed | squad |
| `cli.dashboard` | Dashboard viewed | durationMs |
| `cli.error` | Command failed | command, errorType, errorMessage |
| `cli.goal.set` | Goal created | squad |
| `cli.goal.complete` | Goal completed | squad |
| `cli.memory.query` | Memory searched | query length |
| `cli.login` | User logged in | email domain (not full email) |
| `cli.logout` | User logged out | - |

**Event Payload:**
```json
{
  "event": "cli.dashboard",
  "timestamp": "2024-01-02T12:00:00Z",
  "properties": {
    "anonymousId": "uuid",
    "cliVersion": "0.1.0",
    "durationMs": 234,
    "success": true
  }
}
```

## Storage

### PostgreSQL Tables

| Table | Data | Source |
|-------|------|--------|
| `squads.llm_generations` | API calls (tokens, cost, model) | OTel api_request |
| `squads.tool_executions` | Tool usage (name, duration, success) | OTel tool_result |
| `squads.sessions` | Session aggregates | OTel session context |
| `squads.conversations` | Message content for memory | Engram hook |
| `squads.dashboard_snapshots` | Historical metrics | squads dash |
| `squads.cli_events` | Anonymous CLI usage | squads-cli |

### Redis Keys

| Key Pattern | Data | TTL |
|-------------|------|-----|
| `cost:daily:{date}` | Daily cost total | 48h |
| `cost:squad:{squad}:{date}` | Per-squad daily cost | 48h |
| `tokens:input:{date}` | Daily input tokens | 48h |
| `tokens:output:{date}` | Daily output tokens | 48h |
| `generations:{date}` | Daily API call count | 48h |
| `session:{id}` | Session metadata | 24h |
| `ratelimit:latest:{model}` | Current rate limits | 5m |

## Privacy

### What We Collect

- Anonymous UUID (generated locally, not linked to identity)
- Command names and durations
- Error types (not full stack traces)
- Email domain for login (not full email)
- CLI version

### What We DON'T Collect

- Personal information (name, email, IP)
- File contents or paths
- API keys or secrets
- Full error messages (truncated to 100 chars)
- Conversation content (stored locally only)

### Opt-Out

```bash
# Disable all telemetry
export SQUADS_TELEMETRY_DISABLED=1

# Standard DO_NOT_TRACK
export DO_NOT_TRACK=1

# Or programmatically
import { disable } from 'squads-cli/telemetry';
disable();
```

### Data Inspection

View your local telemetry:
```bash
cat ~/.squads-cli/events.json | jq '.[-10:]'
```

## OTel Collector Configuration

The collector batches and forwards telemetry to the bridge.

**File:** `docker/otel-collector.yaml`

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 100

exporters:
  otlphttp:
    endpoint: http://squads-bridge:8080
    encoding: json

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp]
```

## Cost Tracking

### Model Pricing (per 1M tokens)

| Model | Input | Output |
|-------|-------|--------|
| claude-opus-4-5 | $15.00 | $75.00 |
| claude-sonnet-4 | $3.00 | $15.00 |
| claude-haiku-4.5 | $0.80 | $4.00 |

### Rate Limits by Tier

| Tier | RPM | ITPM (opus/sonnet) | OTPM (opus/sonnet) |
|------|-----|--------------------|--------------------|
| 1 | 50 | 30k | 8k |
| 2 | 1,000 | 450k | 90k |
| 3 | 2,000 | 800k | 160k |
| 4 | 4,000 | 2M | 400k |

## Integration Points

### Langfuse (Optional)

Forward OTel data to Langfuse for observability:

```bash
export LANGFUSE_ENABLED=true
export LANGFUSE_PUBLIC_KEY=pk_...
export LANGFUSE_SECRET_KEY=sk_...
export LANGFUSE_HOST=https://cloud.langfuse.com
```

### Engram/mem0 (Optional)

Forward conversations for memory extraction:

```bash
export ENGRAM_ENABLED=true
export ENGRAM_URL=http://localhost:8000
```

## Debugging

### View Recent OTel Logs

```bash
curl http://localhost:8080/debug/logs | jq
```

### Check Bridge Health

```bash
curl http://localhost:8080/health
```

### Real-time Stats

```bash
curl http://localhost:8080/stats | jq
```

### Cost Summary

```bash
curl "http://localhost:8080/api/cost/summary?period=day" | jq
```
