# TypeScript Migration Plan

## Goals

- Move the `web` service from JavaScript to TypeScript without changing runtime behavior.
- Make API responses, persisted JSON files, and browser-admin payloads share one canonical set of types.
- Keep the production runtime boring: compile TypeScript to JavaScript before Docker image creation, then run Node on built files.
- Avoid a large, risky rename-only PR. Each phase should be independently shippable and easy to verify.

## Current Contract Surfaces

- HTTP API:
  - `GET /api/status`
  - `GET /api/feed/bootstrap`
  - `GET /api/cron/refresh-feed`
  - `GET /api/confess/status`
  - `POST /api/confess`
  - `GET /api/moderation/manifest`
  - `GET /api/moderation/actions`
  - `POST /api/moderation/actions`
  - `DELETE /api/moderation/actions/:id`
- Browser admin client:
  - `web/public/app.js` consumes `/api/status` and `/api/moderation/actions`.
- Persisted stores:
  - feed snapshot cache
  - moderation store
  - confess store
- Relay-facing structures:
  - Nostr events from `nostr-tools`
  - relay hints by event id
  - NIP-11 relay info
  - gateway stats and recent activity entries

## Target Structure

```text
web/
  package.json
  tsconfig.json
  src/
    server.ts
    contracts/
      api.ts
      nostr.ts
      stores.ts
      validation.ts
    feed-snapshot-service.ts
    moderation.ts
    relay-gateway.ts
    http-routes.ts
    ...
    admin-client/
      app.ts
  public/
    index.html
    styles.css
    app.js          # generated build output, not the source of truth
  dist/
    server.js       # generated build output
```

The important rule: source modules import types from `src/contracts/*`; they do not re-declare response or store shapes locally.

## Canonical Types First

Create shared types before renaming most files. These are the highest-value contracts:

- `NostrEvent`: use the event type from `nostr-tools`, plus local aliases for ids, pubkeys, relay URLs, and tag arrays where helpful.
- `RelayHintsByEventId`: `Record<EventId, RelayUrl[]>` at the JSON boundary, `Map<EventId, RelayUrl[]>` internally.
- `ProfileSummary`: `{ name?, displayName?, picture? }`.
- `ProcessedFeedEvent`: `{ postEvent, replies, relayHints?, threadReplyCount, rootWork, replyWork, totalWork, rankingReplyCount }`.
- `FeedBootstrapSnapshot`: `{ fetchedAt, processedEvents, events, relayHintsByEventId, profiles }`.
- `ModerationAction`, `ModerationActionInput`, `ModerationManifest`, `ModerationStore`.
- `ConfessStore`, `ConfessPostRecord`, `ConfessStatus`, `CreateConfessionResponse`.
- `RelayStats`, `RelayRecentActivity`, `RelayInfo`, `StatusResponse`.

The browser admin client should import these types type-only from the same `contracts/api.ts` file used by `http-routes.ts`.

## Runtime Validation

TypeScript types do not validate disk, relay, or HTTP data. Add small runtime validators at trust boundaries:

- `parseFeedBootstrapSnapshot(value): FeedBootstrapSnapshot | null`
- `parseModerationStore(value): ModerationStore | null`
- `parseConfessStore(value): ConfessStore | null`
- `parseModerationActionInput(value): ModerationActionInput`
- `isNostrEvent(value): value is NostrEvent`

Keep validators close to `contracts/validation.ts` so the type and runtime shape cannot drift. Avoid a heavy schema library unless the hand-written validators become noisy.

## Migration Phases

### Phase 1: Tooling and Contract Types

- Add `typescript`, `@types/node`, `@types/express`, and any missing package types.
- Add `web/tsconfig.json` with `strict: true`, `noImplicitAny: true`, `exactOptionalPropertyTypes: true`, and `noUncheckedIndexedAccess: true`.
- Add `npm run typecheck`.
- Add `src/contracts/*` using `.ts` files.
- Keep existing `.js` runtime unchanged in this phase except for optional JSDoc imports if needed.

Verification:

- `npm run check`
- `npm run typecheck`

### Phase 2: Convert Pure Utilities

Convert low-risk modules first:

- `utils.js -> utils.ts`
- `pow.js -> pow.ts`
- pure type guards and contract validators

These modules have small inputs/outputs and are easy to test in isolation.

Verification:

- `npm run typecheck`
- `node dist/server.js --check equivalent`, or keep `node --check dist/server.js`

### Phase 3: Convert Data Services

Convert modules that own persisted and API data:

- `moderation.js -> moderation.ts`
- `feed-snapshot-service.js -> feed-snapshot-service.ts`
- confess store helpers currently in `server.js`, extracted into `confess-store.ts`

This is where shared data structures matter most. Each function that reads JSON from disk should return typed contracts only after validation.

Target ownership:

- `moderation.ts` owns `ModerationStore`, `ModerationAction`, and `ModerationManifest`.
- `feed-snapshot-service.ts` owns `FeedBootstrapSnapshot` production, but imports the snapshot shape from contracts.
- `confess-store.ts` owns `ConfessStore` parsing and persistence.

### Phase 4: Convert HTTP Routes and API Client Together

Convert both sides of admin HTTP contracts in the same PR:

- `http-routes.js -> http-routes.ts`
- `public/app.js -> src/admin-client/app.ts`
- Build `src/admin-client/app.ts` to `public/app.js`

The server should return typed response objects:

- `StatusResponse`
- `FeedBootstrapSnapshot`
- `ModerationActionsResponse`
- `ModerationActionResponse`
- `ConfessStatusResponse`

The browser client should type fetched payloads from those same contracts. Do not duplicate response interfaces in the client.

### Phase 5: Convert Relay and Integration Modules

Convert modules with external runtime dependencies after the contracts are stable:

- `relay-gateway.js -> relay-gateway.ts`
- `x-client.js -> x-client.ts`
- `confess-postcard-renderer.js -> confess-postcard-renderer.ts`
- `http-access.js -> http-access.ts`

These should mostly consume established types rather than define new ones.

### Phase 6: Convert `server.js`

Convert the entrypoint last:

- `server.js -> server.ts`
- Keep configuration parsing in a typed `config.ts`.
- Keep side-effect startup in `server.ts`.
- Move business helpers out of the entrypoint while preserving behavior.

At the end of this phase, `server.ts` should wire typed services together rather than define store formats, API shapes, and orchestration inline.

## Build and Runtime Plan

- Compile server code to `web/dist`.
- Keep source imports extension-compatible for Node ESM.
- Update `web/package.json`:
  - `build`: `tsc`
  - `typecheck`: `tsc --noEmit`
  - `start`: `node dist/server.js`
  - `check`: `npm run typecheck && node --check dist/server.js`
- Update `web/Dockerfile` to run the build during image creation and copy `dist`, `public`, and production dependencies.
- Do not use `tsx` or `ts-node` in production.

## Shared Contract With Wired Client

`wired-admin` serves data consumed by the separate Wired frontend. To avoid drift:

- Keep `FeedBootstrapSnapshot` and `ModerationManifest` stable and documented in `src/contracts/api.ts`.
- Export JSON-schema-like examples or generated `.d.ts` artifacts if the Wired frontend cannot import from this repo directly.
- After each contract change, update the Wired frontend type definitions or tests in the same release train.
- Add snapshot fixture tests that can be consumed by both repos.

## Suggested PR Sequence

1. `ts-tooling-and-contracts`
2. `convert-utils-and-pow-to-ts`
3. `convert-moderation-contracts-to-ts`
4. `convert-feed-snapshot-contracts-to-ts`
5. `type-admin-http-client-and-routes`
6. `convert-relay-and-confess-modules`
7. `convert-entrypoint-and-docker-runtime`

Each PR should include at least one behavior-preserving verification command and avoid mixing refactors with product changes.

## Non-Goals

- Do not redesign the admin UI during the migration.
- Do not change relay, moderation, feed snapshot, or confess behavior unless a type boundary exposes an existing bug.
- Do not introduce a shared package until the contracts are stable enough to justify packaging overhead.
