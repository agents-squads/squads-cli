# Squads Local Stack

Local development infrastructure for squads CLI telemetry and analytics.

## Services

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL | 5433 | Data storage (Langfuse + squads metrics) |
| Langfuse | 3100 | Telemetry UI, LLM tracing |
| Redis | 6379 | Caching, job queues |

> Note: Ports 5433/3100 avoid conflicts with local Postgres/dev servers.

## Quick Start

```bash
# Start all services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f langfuse

# Stop services
docker-compose down

# Stop and remove data
docker-compose down -v
```

## Access

- **Langfuse UI**: http://localhost:3100
  - First run: Create an account (local only, no verification)
  - Create a project and get API keys

## Configure squads CLI

After starting the stack, configure your environment:

```bash
# In your project's .env or ~/.zshrc
export LANGFUSE_HOST=http://localhost:3100
export LANGFUSE_PUBLIC_KEY=pk-lf-...  # From Langfuse UI
export LANGFUSE_SECRET_KEY=sk-lf-...  # From Langfuse UI
export SQUADS_DATABASE_URL=postgresql://squads:squads_local_dev@localhost:5433/squads
```

## Database Schema

The `init-db.sql` creates a `squads` schema with:

- `github_metrics` - Daily GitHub activity (commits, PRs, issues)
- `agent_executions` - Agent run history with cost tracking
- `baselines` - Before/after comparison snapshots

## Upgrade Path

When you outgrow local:

```bash
# Export your data
pg_dump -h localhost -U squads squads > backup.sql

# Migrate to Squads Cloud
squads cloud migrate --from-backup backup.sql
```

## Troubleshooting

**Langfuse won't start:**
```bash
# Check if postgres is ready
docker-compose logs postgres
# Restart langfuse
docker-compose restart langfuse
```

**Port conflicts:**
```bash
# Change ports in docker-compose.yml or use:
LANGFUSE_PORT=3001 docker-compose up -d
```

**Reset everything:**
```bash
docker-compose down -v
docker-compose up -d
```
