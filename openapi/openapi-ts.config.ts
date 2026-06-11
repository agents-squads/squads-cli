import { defineConfig } from '@hey-api/openapi-ts';

/**
 * Codegen config for the squads-api TypeScript types.
 *
 * Source of truth: ./openapi/openapi.json — a committed snapshot of squads-api's
 * FastAPI-emitted OpenAPI spec (see ./openapi/README.md for how to refresh it).
 * Generating from the committed snapshot keeps `npm run gen:client` deterministic
 * and offline — CI never needs a running API.
 *
 * Mode: types-only (`@hey-api/typescript`). We deliberately do NOT generate the
 * request SDK: the modern `@hey-api/sdk` requires the `@hey-api/client-fetch`
 * *runtime* package, which would violate the repo's "no new runtime deps"
 * invariant. The CLI keeps its native-fetch, offline-first client
 * (src/lib/api-client.ts) and binds call sites to these generated types for
 * spec-first drift protection.
 *
 * Run: `npm run gen:client` (regenerates into src/client/). Never hand-edit
 * src/client/** — CI fails the build on any drift.
 */
export default defineConfig({
  input: './openapi/openapi.json',
  output: { path: './src/client', importFileExtension: '.js' },
  plugins: ['@hey-api/typescript'],
});
