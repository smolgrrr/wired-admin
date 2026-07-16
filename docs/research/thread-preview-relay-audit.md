# Thread and preview relay audit

Issue: [#73](https://github.com/smolgrrr/wired-admin/issues/73)

Audited Wired commit: `8bcb2f4` plus the issue-73 review fixes

Evidence run: [`thread-local-2026-07-14-r2`](relay-audit-data/thread-local-2026-07-14.json)

## Outcome

The browser thread path resolves a root, duplicate relay results, and an immediate-parent-only nested reply, and it closes all subscriptions on navigation. The server preview path deduplicates configured-plus-hinted relay results and retains available output when one of two relays disconnects, but its root-only reply filter misses a legacy descendant that references only its immediate parent. No public relay was contacted for the controlled measurements.

Three measured mechanisms deserve follow-up:

1. Browser recursive discovery closes and recreates the full growing reply subscription for every new event. In the three-event/two-relay fixture, one navigation made 8 REQs and received 12 event deliveries for 3 unique IDs. This is deterministic code behavior and local transcript evidence, not an estimate of production frequency.
2. Preview fallback waits its full 2,500 ms timer when one relay sends complete results and EOSE while another disconnects. The result remains complete, but completion is unnecessarily delayed. A connection that finishes after the connection race can also escape cleanup.
3. Preview fallback resolved only 2 of 3 reachable IDs when the nested reply carried only its immediate parent. This is a current metadata-completeness defect, not an efficiency opportunity.

The audit does **not** recommend reducing configured relays, ignoring route/tag hints, bounding recursive depth, accepting the first relay, or shortening completion timers. Those approaches reduce the relay-coverage or completeness contract.

## Production operation inventory

### THR-B1 — browser root retrieval

| Field | Evidence |
| --- | --- |
| User purpose | Resolve the selected thread root before rendering the thread. |
| Trigger and multiplicity | One finite request on thread route mount or route-ID change; one subscription per connected configured/hinted relay. Snapshot/session seeds do not suppress this validation fetch. |
| Type and boundary | Finite query through Wired's shared `RelayPool` and `SubscriptionRegistry`; nostr-tools 2.5.1. |
| Filter | `{ids:[eventId], kinds:[1,1068], limit:1}`. The ID is exact; kind 1068 remains intentional browser compatibility. |
| Relay selection/fan-out | Normalized union of configured `THREAD_RELAYS` and NIP-19 route hints. `ensureRelaysConnected` adds missing connections; the pool reuses existing ones. |
| Lifecycle | Starts after route preparation, closes per relay on EOSE/client EOSE timeout, and is also owned by navigation cleanup. Unavailable relays are omitted after connection failure. |
| Batching/cache/dedup | One root ID. Seed caches improve first paint but are not treated as authoritative. React state deduplicates event IDs. |
| Error/result contract | Other relays can succeed; timeout is indistinguishable from relay EOSE at this boundary. The page remains in a loading placeholder if no root resolves. |
| UX invariant | Configured plus hinted coverage, exact root identity, seed-first timeliness, and authoritative relay refresh remain unchanged. |
| Static evidence | `src/hooks/useThreadEvents.ts:8-28`, `src/nostr/subscriptions/thread.ts:41-54`, `src/nostr/relay-pool.ts:23-62`. |

### THR-B2 — browser recursive live replies

| Field | Evidence |
| --- | --- |
| User purpose | Resolve every reachable reply descendant and continue receiving new replies while the thread is open. |
| Trigger and multiplicity | Starts once on mount. Every newly observed event adds its ID to the parent set and synchronously closes/recreates the subscription across every connected relay. Multiplication is `relay count × (root + newly discovered IDs)`. |
| Type and boundary | Live subscription through the shared pool/registry. |
| Filter | `{#e: first 50 discovered IDs, kinds:[1], limit:100}`; no age bound. The parent cap and initial result limit are not completeness guarantees. |
| Relay selection/fan-out | Same configured/hinted union as THR-B1. |
| Lifecycle | The old subscription is closed before its replacement is opened. The current replacement closes on route cleanup. EOSE does not close it. There is a small replacement gap in which live delivery depends on the new subscription's historical replay. |
| Batching/cache/dedup | Parent IDs are combined in one filter. IDs are deduplicated in a `Set`; UI state deduplicates results. Replacement re-requests the historical result set. |
| Retry/error contract | Replacement is discovery-driven, not an error retry. Relay EOSE is ignored for workflow completion; unavailable connected targets are skipped. |
| UX invariant | All descendants reachable through any configured/hinted relay, including immediate-parent-only legacy replies, plus live arrivals and prompt navigation cleanup. |
| Runtime evidence | Each of 20 cold local runs resolved all 3 required IDs. Per run: 2 opened connections, 8 REQ, 8 matching EOSE/CLOSE, 12 deliveries/3 unique IDs, 4 repeated operations, fan-out 2. Initial-content p50/p95 was 7/28 ms; completion p50/p95 was 28/48 ms. Exact filters and byte/lifetime samples are persisted in the run JSON. These timings are local control values only. |
| Static evidence | `src/nostr/subscriptions/thread.ts:12-58`, `src/nostr/subscriptions/query-limits.ts:3-6,37-47`. |

### THR-B3 — browser referenced context

| Field | Evidence |
| --- | --- |
| User purpose | Fetch notes referenced by the displayed root so prior conversation context can render. |
| Trigger and multiplicity | Once after the root resolves and whenever its ordered `e`-tag ID list changes. |
| Type and boundary | One finite shared-pool query across configured thread relays. |
| Filter | `{ids: opMentionIds, kinds:[1], limit: opMentionIds.length}`. IDs are exact and batched. |
| Relay selection/fan-out | Configured `THREAD_RELAYS`; route hints are not forwarded to this context request. This is a coverage gap to verify, not an efficiency recommendation. |
| Lifecycle | Close on per-relay EOSE/client EOSE timeout and on navigation cleanup. The measured missing ID completed as absent only after both relay EOSE signals. |
| Batching/dedup/cache | All context IDs are combined in one exact-ID filter with `limit` equal to ID count. IDs can repeat if tags repeat; returned events are deduplicated in React state. No cross-screen result cache beyond seed events. |
| Retry/error/result contract | No application retry. Other relays can still supply an ID; EOSE-versus-timeout is not exposed to the UI. Empty/missing IDs do not block root/reply rendering. |
| UX invariant | Every referenced context note reachable through applicable coverage remains available without delaying the root/replies. |
| Runtime evidence | 20 warm dependent-workflow runs over two relays: 2 REQ, 2 EOSE/CLOSE, one delayed reachable ID returned, one unavailable ID completed missing, p50/p95 17/19 ms. Exact filter, 182-byte requests, returned bytes, and lifetimes are persisted. |
| Static evidence | `src/hooks/useThreadViewModel.ts:31-43`, `src/nostr/subscriptions/index.ts:19-39`. |

### THR-S1 — server thread preview snapshot lookup

This is not itself relay traffic, but it gates relay fallback. Both configured snapshot URLs are fetched concurrently with a 1,500 ms abort. A valid snapshot hit returns the root excerpt and stored recursive reply count without relay work. A miss, invalid snapshot, timeout, or absent root starts THR-S2. Evidence: `lib/threadPreview.ts:41-76,146-160`.

### THR-S2 — server preview relay fallback

| Field | Evidence |
| --- | --- |
| User purpose | Supply thread HTML/social-card excerpt and reply count when snapshots miss. Called independently by `/api/thread` and `/api/thread-card`. |
| Trigger and multiplicity | One fallback per uncached endpoint invocation. A social preview can invoke both endpoints, so identical fallback work can occur twice; actual frequency is unknown and requires platform request logs. |
| Type and boundary | Direct `Relay.connect` per target; nostr-tools 2.5.1; no shared server pool. One finite subscription per connected relay. |
| Filters | One REQ containing OR filters `{ids:[eventId], kinds:[1], limit:1}` and `{#e:[eventId], kinds:[1], limit:500}`. The reply filter admits NIP-10 descendants carrying the root tag. |
| Relay selection/fan-out | Normalized union of NIP-19 hints followed by configured `THREAD_RELAYS`. All targets are attempted concurrently; it does not stop at first success. |
| Lifecycle | Connection phase races all connects against 2,500 ms. Query finishes on EOSE from every connected relay or another 2,500 ms timer, then closes subscriptions and connected sockets. Relay disconnect is not counted as settled, and late connection promises are not cancelled or closed. |
| Dedup/cache | Event map deduplicates IDs across relays. No in-process coalescing between HTML and card endpoints. CDN behavior is endpoint-specific and was not inferred. |
| Error/result contract | Partial relay success is accepted. Missing root returns no preview. EOSE and timeout are not exposed to the caller. |
| UX invariant | Intended: snapshot-first initial speed, all configured/hinted relay coverage, complete reachable reply count, excerpt identity, and partial-relay success. Current root-only traversal violates completeness for immediate-parent-only legacy descendants. |
| Runtime evidence | Normal 20-run local baseline decoded one NIP-19 hint and unioned it with one configured relay: 2 connections, 2 exact REQ, matching EOSE/CLOSE, 6 deliveries/3 unique IDs, p50 27 ms/p95 34 ms. Degraded scenario retained 3 IDs but completed at 2,506 ms. Legacy scenario resolved only 2/3 reachable IDs. |
| Static evidence | `lib/threadPreview.ts:78-132`; callers `api/thread.ts:42-57`, `api/thread-card.tsx:96-103`. |

## Scenario coverage

| Scenario | Evidence and result |
| --- | --- |
| Root retrieval, configured/hinted selection | An encoded `nevent` supplied one local hint; the real decoder and selection helper unioned it with a distinct injected configured relay, and raw REQs prove both URLs were used. Browser cold runs used the same normalized selected-URL boundary. |
| Recursive descendants and duplicates | Immediate-parent-only nested reply resolved; 12 deliveries deduplicated to the exact 3 required IDs. |
| EOSE, replacement, cleanup | Raw transcript proves each root/replacement request and 8 matching CLOSE messages per navigation. |
| Required referenced context | Exact two-ID batch across two relays returned one delayed reachable note, completed one absent note only after both EOSE signals, and matched every REQ to EOSE/CLOSE. |
| Delayed and unavailable relays | Preview delayed relay returned all required IDs while the second connection closed; output stayed complete. |
| Preview fallback | Snapshot 404 forced the real `resolveThreadPreview` fallback and real direct-relay implementation. |
| Snapshot preview hit | Existing `lib/threadPreview.test.ts` proves no relay fallback is required and preserves stored `threadReplyCount`. |
| Navigation changes | React effect owns the composite handle; late async creation is immediately closed after cancellation (`useNostrSubscription.ts:38-76`). |
| Positional/legacy tags | Browser immediate-parent-only descendant fixture proves recursive discovery. The preview legacy fixture proves its root-only filter misses that same reachable shape; compliant root-marked descendants remain covered. |

## Findings

### F-THR-1 — growing subscription replacement deterministically replays work

This is a **static defect with local runtime confirmation**, not a public-load claim. `refreshReplySubscription` closes the active subscription and submits the entire growing parent filter for every new ID. The fixture's 3 unique events produced 12 deliveries. The first-50 parent cap also means discovery stops expanding after the cap, while `limit:100` can truncate historical matches; neither value proves completeness.

No immediate production optimization is approved here because naïve alternatives create a live-delivery gap, omit immediate-parent-only descendants, or increase active subscriptions. The completeness caps should be fixed before relay-work reduction is evaluated.

### F-THR-2 — degraded preview completion waits for a relay that has already closed

This is a **measured lifecycle defect**. Query completion increments only on EOSE. A closed relay remains in the expected EOSE count, so the workflow waits 2,500 ms even after the other relay has returned the complete result and EOSE. Treating terminal close as settled preserves coverage and results while removing only dead waiting.

### F-THR-3 — late preview connections can escape ownership

This is a **static lifecycle defect**. The outer `Promise.race` does not cancel individual `Relay.connect` calls. A connection that resolves after the timer can be pushed into `relays` after the function has returned or after the subscription array was built, and is not guaranteed to close. The fix must retain the full 2,500 ms connection opportunity while closing any relay that arrives after the connection phase.

### F-THR-4 — HTML and card preview fallbacks may duplicate identical relay work

This is a **runtime hypothesis only**. Both endpoints call `resolveThreadPreview`, but real duplication depends on CDN hits, request ordering, serverless instance reuse, and snapshot availability. Do not claim a reduction until ordinary request logs and transcript correlation establish frequency.

### F-THR-5 — server preview does not recursively resolve legacy descendants

This is a **measured completeness defect**. THR-S2 asks only for the root and events whose `e` tags include the root. A nested reply with only its immediate parent does not match, so the local relay correctly withheld it and the preview returned 2 of 3 reachable IDs. The browser already demonstrates the required recursive frontier behavior. A fix may add relay work; it is required for the stated UX contract and must not be misrepresented as an efficiency reduction.

## Recommendation records

### R-THR-1 — settle and own degraded preview connections

1. **Identity/ownership:** THR-S2; Wired server preview owner; operational observer is the deployment owner.
2. **Evidence:** F-THR-2 and F-THR-3; degraded local run resolved 3/3 IDs but completed at the 2,500 ms fallback boundary.
3. **Change:** give every connection attempt an owned terminal state; close late arrivals; count relay close/error as terminal alongside EOSE after subscription start; finish only when every attempted connected relay is EOSE/closed or the unchanged deadline expires.
4. **Expected impact:** unchanged targets, REQ, filters, and returned IDs; fewer leaked sockets; completion below the fallback deadline when all relays have already terminated. No percentage is claimed.
5. **Confidence:** high for lifecycle/cleanup, based on direct code and transcript evidence.
6. **UX proof obligations:** identical relay target set; exact preview output; delayed successful relay still allowed through the existing deadline; normal p95 no worse than 34 ms in equivalent fixture; degraded completion no longer waits after all targets terminate.
7. **Rejected alternatives:** first-success completion loses slower-relay results; shorter fixed timeout changes coverage; removing the failing relay changes intended fan-out.
8. **Verification:** normal, delayed, late-connect, disconnect-before-EOSE, no-EOSE, and all-fail transcripts; exact ID equivalence; 20-run before/after local sample and staging observation.
9. **Rollout:** ordinary draft PR; observe preview failures and latency for one deployment window; stop on missing IDs or p95 regression.
10. **Rollback:** revert the isolated preview lifecycle change if output identity, partial-success behavior, or p95 regresses.

### R-THR-2 — make server preview reply resolution recursive

1. **Identity/ownership:** THR-S2; Wired server preview owner.
2. **Evidence:** F-THR-5; controlled relay coverage exposed 3 reachable IDs and the current preview returned 2.
3. **Change:** after the root-filter response, iteratively query the newly discovered reply IDs as parent IDs across the identical configured-plus-hinted relay set until the frontier is empty; deduplicate IDs across iterations; retain the existing overall failure deadline and close every finite subscription/connection.
4. **Expected impact:** improves result completeness and can increase REQ/returned bytes for legacy threads; no relay reduction is claimed. Exact added work is frontier-dependent and must be measured.
5. **Confidence:** high that recursion is required; the browser implementation and failing local scenario establish the gap.
6. **UX proof obligations:** 3/3 legacy fixture IDs; compliant and snapshot-hit output unchanged; configured/hinted coverage unchanged; normal first-result and completion p95 remain within an explicitly approved preview target.
7. **Rejected alternatives:** counting only root-tagged replies is incomplete; arbitrary depth/parent/result caps silently omit metadata; dropping legacy support contradicts the browser contract.
8. **Verification:** compliant and immediate-parent-only deep/wide fixtures, duplicate relays, missing EOSE, disconnect, exact ID equality, filters/bytes/lifetimes, and cold 20-run p50/p95.
9. **Rollout:** isolated server preview change with output-count and latency observation; stop on missing roots, fewer reply IDs, socket leaks, or material p95 regression.
10. **Rollback:** revert the recursive resolver if it regresses availability while retaining the failing completeness fixture as a known blocker.

### R-THR-3 — replace silent browser reply caps with complete chunked traversal before optimizing replay

1. **Identity/ownership:** THR-B2; Wired browser thread owner.
2. **Evidence:** deterministic first-50 parent slicing and `limit:100`; no evidence that production threads stay below either bound.
3. **Change:** define chunked parent coverage and historical pagination with explicit completion, preserve a live overlap during subscription replacement, then compare a split backfill/live filter against the current growing replay. This requires a prototype ticket before production code.
4. **Expected impact:** primary impact is correctness, not guaranteed reduction. The follow-on experiment measures whether split backfill/live filters reduce returned duplicates and bytes without adding REQ or latency.
5. **Confidence:** high that caps cannot prove completeness; medium that the split-filter design reduces work.
6. **UX proof obligations:** every descendant at depth >2 and beyond 50 parents/100 matches resolves; configured/hinted coverage unchanged; no live handoff gap; first content and completion p95 do not regress.
7. **Rejected alternatives:** reducing depth, age, relays, or limits silently omits replies; per-parent permanent subscriptions can multiply relay subscription load; close-before-open preserves the current handoff gap.
8. **Verification:** wide/deep fixtures, same-second arrivals, delayed relay, event during handoff, legacy immediate-parent-only tags, exact ID set, REQ/bytes/delivery comparison, and navigation cleanup.
9. **Rollout:** feature-flag the traversal engine; start with staging/maintainer sessions and compare transcripts; stop on any missing ID or p95 regression.
10. **Rollback:** disable the flag to restore current traversal; retain transcript instrumentation.

### R-THR-4 — measure cross-endpoint preview coalescing before designing it

1. **Identity/ownership:** THR-S1/S2 and architecture ticket #77.
2. **Evidence:** two independent call sites; runtime multiplicity unknown.
3. **Change:** correlate ordinary HTML/card request IDs, snapshot hit/miss, and fallback transcripts. Design request coalescing/cache only if repeated same-key fallback is observed within a safe freshness window.
4. **Expected impact:** unknown until measurement; metric is eliminated duplicate connections/REQ per event reference.
5. **Confidence:** low on frequency, high that measurement is required.
6. **UX proof obligations:** no stale excerpt/reply metadata, no slower cache miss, same relay coverage on refresh, and isolated failures.
7. **Rejected alternatives:** an assumed TTL cache may stale reply count; passing arbitrary excerpt query parameters creates integrity/size concerns; dropping card resolution harms social UX.
8. **Verification:** ordinary staging traces, cache-key/coalescing tests, exact preview equivalence, p50/p95 hit and miss paths.
9. **Rollout:** instrumentation first; any cache behind a flag with hit/miss/error counters.
10. **Rollback:** disable cache/coalescing and return to independent snapshot-first resolution.

## Decision

R-THR-1 is a clear no-UX-tradeoff implementation candidate after its failure-edge tests are red. R-THR-2 is required to restore preview completeness even though it may add relay work. R-THR-3 is correctness-first and needs a prototype because an unproven browser subscription rewrite could increase relay work or miss live replies. R-THR-4 remains measurement work and must not be sold as relay savings yet.

## Post-audit implementation evidence

R-THR-1 was implemented after the audit closed. The unchanged two-relay scenario retained all 3 required IDs, the same 2 REQ/2 CLOSE and relay fan-out, and a separate test proves a connection arriving after the deadline is closed. In the controlled comparison, normal p95 was 34 ms before and 31 ms after; the disconnect scenario completed in 26 ms after instead of 2,506 ms at the deadline. These are fixture comparisons only, not public-relay or production-load estimates. Raw comparison: [`thread-preview-lifecycle-after-2026-07-14`](relay-audit-data/thread-preview-lifecycle-after-2026-07-14.json).
