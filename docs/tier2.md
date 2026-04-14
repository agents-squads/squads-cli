# Tier 2: Local Services

squads-cli operates in one of two tiers:

- **Tier 1** (default) — file-based only. All state lives in JSONL, markdown, and git. Zero external dependencies. Works everywhere.
- **Tier 2** — local Docker services. Adds Postgres, Redis, a REST API, and a Bridge service for webhook-driven workflows and richer observability.

Tier 2 is optional and fully local. Most users never need it.

## What Tier 2 Adds

| Service   | Port  | Purpose                                  |
|-----------|-------|------------------------------------------|
| API       | 8090  | REST API for agent executions and jobs   |
| Bridge    | 8088  | GitHub webhook receiver                  |
| Postgres  | 5432  | Persistent job queue (Procrastinate)     |
| Redis     | 6379  | Pub/sub and caching                      |

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop) installed and running
- The `agents-squads/engineering` repo cloned as a sibling to this repo:

```
~/agents-squads/
  squads-cli/         ← this repo
  engineering/
    docker/
      docker-compose.yml   ← Tier 2 services definition
```

squads-cli looks for the compose file at:

1. `~/agents-squads/engineering/docker/docker-compose.yml`
2. `~/agents-squads/engineering/docker/docker-compose.yaml`
3. `../engineering/docker/docker-compose.yml` (relative to cwd)

## Usage

### Start services

```bash
squads services up
```

Expected output:

```
  Starting Tier 2 services...

  docker compose up -d
  [Docker output]

  Services started. Waiting for health checks...
  Tier 2 active. All services healthy.

  API:      http://localhost:8090
  Bridge:   http://localhost:8088
  Postgres: localhost:5432
  Redis:    localhost:6379
```

Optional profiles:

```bash
squads services up --webhooks    # also start ngrok tunnel for GitHub webhooks
squads services up --telemetry   # also start OpenTelemetry collector
```

### Check status

```bash
squads services status
```

Expected output (when running):

```
  Services (Tier 2)

  up  squads-postgres  0.0.0.0:5432->5432/tcp
  up  squads-redis     0.0.0.0:6379->6379/tcp
  up  squads-api       0.0.0.0:8090->8090/tcp
  up  squads-bridge    0.0.0.0:8088->8088/tcp

  Database
    Procrastinate jobs: 12
    Agent executions:  47
```

Expected output (when not running):

```
  Services (Tier 1)

  No Docker containers running.
```

### Stop services

```bash
squads services down
```

Expected output:

```
  Stopping Tier 2 services...

  [Docker output]

  Services stopped. Falling back to Tier 1 (file-based).
```

If no compose file is found:

```
  No docker-compose.yml found. Nothing to stop.
```

## Fallback Behavior

squads-cli always degrades gracefully to Tier 1 when Tier 2 services are unavailable:

- Commands that read from Postgres fall back to JSONL files.
- Commands that post to the API are silently skipped or use local state.
- `squads services status` reports `Tier 1` and shows no containers.

You can always run `squads services status` to confirm which tier is active.

## Tier Detection

At startup, squads-cli probes `http://localhost:8090/health` and `http://localhost:8088/health` with a 1.5 s timeout. If the API responds with HTTP 2xx, Tier 2 is active. The result is cached for the lifetime of the process.

To check programmatically:

```typescript
import { detectTier } from 'squads-cli/lib/tier-detect';

const info = await detectTier();
console.log(info.tier);          // 1 or 2
console.log(info.services.api);  // true | false
```
