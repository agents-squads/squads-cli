# Vendored OpenAPI spec

`openapi.json` is a **committed snapshot** of [`squads-api`](https://github.com/agents-squads/squads-api)'s
FastAPI-emitted OpenAPI spec. It is the single source of truth for the generated
TypeScript types in `src/client/` (see `../openapi-ts.config.ts`).

Vendoring the snapshot (instead of fetching a live `/openapi.json`) keeps
`npm run gen:client` **deterministic and offline** — CI regenerates and diffs the
client without ever needing a running API.

## Regenerate the TS types from the snapshot

```bash
npm run gen:client      # rewrites src/client/ from openapi/openapi.json
```

CI runs this and fails on any drift, so the committed `src/client/` always
matches this snapshot.

## Refresh the snapshot (when squads-api changes)

The snapshot is produced from a local `squads-api` checkout — `app.openapi()`
works without a database (the DB only opens in the FastAPI `lifespan`):

```bash
# from a squads-api checkout (sibling repo)
ENV=development API_SECRET=dummy .venv/bin/python -c "
import json
from api import app
spec = app.openapi()
json.dump(spec, open('<path-to>/squads-cli/openapi/openapi.json', 'w'), indent=2, sort_keys=True)
open('<path-to>/squads-cli/openapi/openapi.json', 'a').write('\n')
"

# then, in squads-cli:
npm run gen:client
git add openapi/openapi.json src/client
```

`sort_keys=True` keeps diffs minimal and stable across refreshes.

> Note (2026-06): the CLI's `/agent-executions` route in squads-api takes a raw
> `Request` (no Pydantic model), so the spec types its body as `never` and its
> response as `unknown`. Full request/response typing for that endpoint is gated
> on squads-api adding Pydantic models — tracked as a follow-up on
> `agents-squads/hq#419`. The `/cognition/signals*` endpoints the CLI also calls
> are not present in the served spec at all.
