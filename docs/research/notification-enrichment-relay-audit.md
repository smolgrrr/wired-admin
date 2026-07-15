# Notification and enrichment relay audit

Issue: [#75](https://github.com/smolgrrr/wired-admin/issues/75)

Audited branches: Wired `codex/relay-efficiency-improvements`; wired-admin `codex/relay-efficiency-audit`

Evidence: [`notification-enrichment-local-2026-07-14`](relay-audit-data/notification-enrichment-local-2026-07-14.json), with the one-shot context baseline reused from [`thread-local-2026-07-14`](relay-audit-data/thread-local-2026-07-14.json).

## Outcome

The notification path resolved the exact authored, tagged, duplicate-match, and peer-disconnect fixture through two local relays. Profile enrichment used one author batch, received competing metadata from both relays, and the production hook selected the newest input and reused its positive cache. Quote enrichment resolved snapshot hits without relay work, fell through on snapshot misses/errors, resolved fallback and delayed hinted events, completed an empty result behind a stale hint, and closed work that resolved after unmount. Every normal finite transcript matched each REQ subscription ID to its EOSE and CLOSE. No controlled scenario contacted a public relay.

Two controlled findings were clear no-UX-tradeoff candidates and are implemented on the audit branch. Notification queries no longer request kind-7 reactions that `useFilteredNoteSubscription` unconditionally discarded, and an already-connected extra quote hint now receives its exact-ID query once rather than twice. Exact displayed/quoted result IDs and relay fan-out stayed unchanged; controlled p95 improved rather than regressed. Profile batching prevents same-task duplicates, but a consumer mounted while the first request is still live starts the same pubkey query again; fixing that requires owning the subscription until EOSE rather than merely until its handle is created.

The audit found no safe basis for adding a notification `since`, reducing relay coverage, lowering limits, suppressing fallback queries, or making quoted context/profile metadata best-effort. Notification limits and the 250-profile cap are completeness risks, not opportunities to do less work.

## Operation inventory

| ID | Purpose and trigger | Filter / relay coverage | Lifecycle, batching, cache, dedup | Evidence and UX invariant |
| --- | --- | --- | --- | --- |
| NOT-1 | “Your transmissions” and authored activity when notification page mounts or local keys change. | `{authors:pubkeys, kinds:[1], limit:25}` over the initialized default relay pool. No time boundary. | One finite subscription per connected relay; close on aggregate EOSE. The hook deduplicates IDs. Kind 7 was removed because the same hook unconditionally discarded it. | `notifications.ts`, `useNotificationEvents.ts`, `useFilteredNoteSubscription.ts`, `noteEvents.ts`. Preserve every displayed authored note and completion state. |
| NOT-2 | Mentions of any local key in the same page lifecycle. | `{#p:pubkeys, kinds:[1], limit:50}` over the same pool. No time boundary. | Independent finite subscription; notification sync becomes `synced` only after NOT-1 and NOT-2 aggregate EOSE. Eight-second UI timer marks degraded without cancelling results. | Current controlled path: 4 total REQ/EOSE/CLOSE over two relays, 6 deliveries/2 displayed note IDs, p50/p95 completion 29/39 ms. Preserve authored/tagged union and partial results. |
| ENR-1 | Profile for every `PostCard`, quote, inline `npub/nprofile`, and reply context. | One `{authors:[pending], kinds:[0], limit:min(authors,250)}` filter over profile/thread relays. | Module-global positive cache; same-microtask consumers batch and cached pubkeys skip relay work. Newest `created_at` wins. There is no negative cache. `inflightBatch` ends when the subscription handle is created, not at EOSE. | `useProfiles.ts`, `subscriptions/index.ts`. Twenty controlled two-author batches: 2 REQ, 4 deliveries, p50/p95 34/34 ms. Production-hook callbacks selected newest over older/stale competing events and served a later consumer without a second query. A third consumer mounted before any profile response did cause a duplicate query. Preserve timely newest metadata. |
| ENR-2 | Exact earlier/context notes referenced by the thread OP. | `{ids:eventIds, kinds:[1], limit:eventIds.length}` over all thread relays. | One finite multi-ID subscription; hook-level ID dedup. No tag relay hints are forwarded. | `useThreadViewModel.ts`, `subNotesOnce`. Reused 20-run baseline: 2 REQ over two relays, p50/p95 17/19 ms, exact context result. Preserve earlier context identity. |
| ENR-3 | First attempt to satisfy quoted `note/nevent/naddr` references used by `PostCard` bodies. | Browser first loads the coalesced/positively cached feed bootstrap snapshot over HTTP; snapshot hits create no relay request. Missing refs continue to ENR-4. | Per-hook state deduplicates IDs; bootstrap profiles seed the global profile cache. A failed bootstrap falls through to relays. | `useQuotedEvents.ts`, `feedBootstrapClient.ts`. Hook scenarios prove snapshot hit = zero relay subscription, miss/error = exact relay fallback refs, missing becomes failed only after its completion callback, and a late subscription handle is closed after unmount. Preserve snapshot first paint and live fallback. |
| ENR-4 | Relay fallback for each quote missing from snapshot. | One exact `{ids:[id], kinds:[1,1068], limit:1}` request per ref over PoW plus default/configured quote fallback relays. Extra ref hints are owned by ENR-5. | Finite close on EOSE. Ref completion is reported from fallback only when no extra hint exists. Different quote refs are not batched. | Three-ref fixture: fallback quote, hinted quote, and missing/stale-hint quote resolved 2/3 with explicit completion for all three. Preserve fallback first-result timing and missing-state accuracy. |
| ENR-5 | Extra relay hints from `nevent/naddr` or tags. | After fallback starts, connect distinct hints, then issue the same per-ref exact filter once over extra hints. | Owner closes late-added handles after unmount. Stale hint failure yields zero protocol request and still completes the ref. | Current normal fixture: hinted coverage adds one REQ, resolves the exact hinted ID, and does not delay fallback. Preserve hinted coverage and fallback-first behavior. |

## Controlled measurements

| Workflow | Samples | Exact output | Local relay work | Timing |
| --- | ---: | --- | --- | --- |
| Notifications normal | 20 | 2/2 displayed IDs | 4 REQ/EOSE/CLOSE; 6 deliveries/2 unique; fan-out 2 | complete p50/p95 29/39 ms |
| Notifications peer disconnect | 1 | 2/2 displayed IDs from healthy peer | 4 REQ; 3 deliveries; 2 healthy EOSE; fan-out 2 | deterministic degraded fixture |
| Profiles | 20 | 2/2 pubkeys; newest 2/2 inputs; production hook selects newest and caches it | 2 REQ/EOSE/CLOSE; 4 deliveries; fan-out 2 | complete p50/p95 34/34 ms |
| Quotes fallback/hint/missing | 1 | fallback + hinted resolved; missing ref explicitly completed | 7 REQ/EOSE/CLOSE; 3 deliveries/2 unique; fan-out 3 | hint event 20 ms, EOSE 25 ms |
| Quotes normal fallback + preconnected hint | 20 | 2/2 IDs | 5 REQ/EOSE/CLOSE; 3 deliveries; one hint query; fan-out 3 | complete p50/p95 21/23 ms |
| Quote snapshot orchestration | 4 hook scenarios | hit, miss, error, and late-unmount ownership | hit creates zero relay subscription; miss/error pass exact refs to relay owner | deterministic hook state |
| One-shot thread context | 20 | exact required context | 2 REQ/EOSE/CLOSE; 1 delivery; fan-out 2 | complete p50/p95 17/19 ms |

These timings and counts are fixture baselines, not estimates of production relay load, cache hit rates, notification volume, or latency.

## Findings

### F-NE-1 — kind-7 notification results were queried and then unconditionally discarded (fixed on branch)

NOT-1 requested kinds 1 and 7. Its only production consumer passes the results through `filterNoteEvents`, which retains kinds 1 and 1068, and the notification page cannot observe reaction events. In the controlled before run, each relay returned one kind-7 event that contributed no displayed result. The branch now requests kind 1 only: exact displayed IDs remain 2/2, per-run deliveries fall 8→6, authored request bytes 121→119, fan-out/REQ remain 2/4, and p95 is 42→39 ms in the fixture.

### F-NE-2 — notification limits cannot prove complete activity

NOT-1 has `limit:25` and NOT-2 has `limit:50`, without pagination or a persisted cursor. Both span all time. This bounds returned volume but can omit older authored/mentioned activity and makes “accurate notifications” dependent on relay ordering. Adding `since`, lowering limits, or first-relay completion would worsen the contract. A cursor/pagination design is correctness work and may increase requests.

### F-NE-3 — an already-connected extra quote hint received the same query twice (fixed on branch)

ENR-4 included `ref.relays` in its requested relay list. ENR-5 separately identified those same non-fallback hints and queried them after `ensureRelaysConnected`. When a hint was already connected, both paths targeted it. The branch now keeps extra hints out of the immediate fallback target list and queries them once in ENR-5. Exact quote IDs remain 2/2; normal controlled work falls 6→5 REQ and 4→3 deliveries, hint REQ 2→1, fan-out remains 3, and p95 is 27→23 ms.

### F-NE-4 — profiles can be re-requested while the first subscription is still live

The positive cache and microtask pending set effectively batch simultaneous consumers. However, `inflightBatch` resolves as soon as `subProfilesOnce` returns its handle, before relay EOSE. Pending pubkeys are removed at request start and are not marked in-flight by pubkey. A later consumer for the same still-missing pubkey therefore starts a second request. The controlled hook test produced exactly this one-then-two call sequence. Any fix must continue delivering newer events from all relays and must not negative-cache transient misses indefinitely.

### F-NE-5 — quote fallback uses one subscription per reference

Three refs over two fallback relays produced six fallback REQ before the hinted query. Refs sharing identical fallback coverage could use a batched IDs filter while still marking each unresolved ID failed at aggregate EOSE. The repository provides no ordinary quote-count distribution, so real savings and p95 impact are unknown. Do not trade per-ref early completion for fewer requests without controlled timing evidence.

### F-NE-6 — profile and notification caps are silent completeness boundaries

A batch can include more than 250 profile authors while its filter limit remains 250, with no chunking. Notification query limits similarly lack cursors. These are static completeness defects. Smaller caps are rejected; complete chunking/pagination may add relay work.

## Recommendation records

### R-NE-1 — remove unobservable kind-7 notification retrieval

1. **Identity/ownership:** NOT-1; Wired notification subscription owner.
2. **Evidence:** F-NE-1, production filter chain, and controlled raw/displayed identity.
3. **Change:** query kind 1 only in the authored filter. Keep authors, limit, relays, EOSE aggregation, timeout state, and tag query unchanged.
4. **Expected impact:** same 4 REQ in the baseline, narrower authored filters and no reaction event bytes; reduction depends on relay reaction results and is not estimated.
5. **Confidence:** high; kind 7 is unconditionally discarded by the only consumer.
6. **UX invariants:** exact displayed authored/mention IDs, same sync state and completion p95, same relay fan-out.
7. **Rejected alternatives:** removing the authored filter loses local transmissions; changing limits or adding `since` changes history.
8. **Verification:** before/after transcripts with authored note, reaction, duplicate authored+tagged note, peer disconnect, exact displayed IDs, request bytes, p95.
9. **Rollout:** isolated filter change; observe displayed notification count and sync completion.
10. **Rollback:** restore kind 7 if a product surface begins rendering reactions.

### R-NE-2 — query each extra quote hint once

1. **Identity/ownership:** ENR-4/ENR-5; quoted-event subscription owner.
2. **Evidence:** F-NE-3; preconnected hint received the exact filter twice.
3. **Change:** initial fallback relay lists contain only fallback coverage; connect/query extra hints once in ENR-5. Keep fallback query immediate and independent of hint connection.
4. **Expected impact:** preconnected extra hint requests/deliveries 2→1 per ref; no change when the hint was not connected. Production frequency is unknown.
5. **Confidence:** high for protocol identity, unknown savings frequency.
6. **UX invariants:** exact quote IDs, fallback-first timing, every extra hint attempted, stale-hint completion, cleanup after unmount.
7. **Rejected alternatives:** waiting for hints delays fallback; dropping hint queries loses context; first-success cancellation may miss competing valid kinds.
8. **Verification:** preconnected/unconnected/delayed/stale hints, fallback hit/miss, kind 1/1068, exact callbacks, p95 and cleanup.
9. **Rollout:** isolated relay-list change with hint-request counters.
10. **Rollback:** restore the redundant initial hint target while retaining the duplicate transcript.

### R-NE-3 — own profile requests through EOSE and deduplicate in-flight pubkeys

1. **Identity/ownership:** ENR-1; global profile cache owner.
2. **Evidence:** F-NE-4 runtime hook sequence; real frequency unknown.
3. **Change:** track in-flight pubkeys until aggregate EOSE/terminal settlement; attach later consumers to the same request. Clear misses at completion so later retries remain possible, optionally with a short evidence-backed negative TTL.
4. **Expected impact:** removes overlapping identical author queries; no numeric production estimate.
5. **Confidence:** high in mechanism, low in occurrence rate.
6. **UX invariants:** newest metadata from every covered relay, immediate positive-cache hits, retry after transient miss, no delayed first request.
7. **Rejected alternatives:** permanent negative cache makes profiles stale/missing; first profile wins can select older metadata; lowering coverage harms freshness.
8. **Verification:** same-task and staggered consumers, older/newer competing events, missing pubkey, terminal relay, retry after EOSE, unmount.
9. **Rollout:** cache-level counters for pending/in-flight/cache-hit and selected profile age.
10. **Rollback:** return to current positive-cache-only behavior.

### R-NE-4 — design complete notification/profile pagination before changing limits

1. **Identity/ownership:** NOT-1/2 and ENR-1; notification/profile domain owners.
2. **Evidence:** F-NE-2/6 static bounds; no claim about production truncation frequency.
3. **Change:** define a cursor/exhaustion contract for notifications and chunk profile authors above the relay-safe batch size. Deduplicate IDs and preserve newest replaceable-event selection.
4. **Expected impact:** correctness first; may add REQ and bytes. No efficiency claim.
5. **Confidence:** high that caps cannot prove completeness; medium on pagination design.
6. **UX invariants:** current first-content p95, all current results, explicit older-history loading/completion, newest metadata.
7. **Rejected alternatives:** smaller limits, arbitrary `since`, first relay, or “recent only” silently lose activity.
8. **Verification:** >25 authored, >50 tagged, >250 pubkeys, duplicates/same timestamps, delayed/no-EOSE relays, exact union.
9. **Rollout:** prototype and staged counters before enabling pagination.
10. **Rollback:** retain known bounded behavior rather than ship partial cursor logic.

### R-NE-5 — prototype quote batching only with timing equivalence

1. **Identity/ownership:** ENR-4/5; quoted-event owner.
2. **Evidence:** F-NE-5 controlled per-ref multiplicity; ordinary ref counts unknown.
3. **Change:** group refs with identical relay coverage into exact-ID filters while retaining per-ID result/failure bookkeeping and independent extra-hint groups.
4. **Expected impact:** controlled three-ref fallback could fall from 6 to 2 REQ; no production estimate.
5. **Confidence:** high in controlled arithmetic, low in real savings/timing equivalence.
6. **UX invariants:** no first-quote or completion p95 regression, exact kind 1/1068 results, missing-state accuracy, cleanup.
7. **Rejected alternatives:** one global filter ignores hint coverage; EOSE/debounce waiting can delay visible quotes.
8. **Verification:** one/many refs, mixed hints, partial results, delayed EOSE, byte/REQ and per-ref completion comparison.
9. **Rollout:** prototype first; ship only after equivalent timing and identity.
10. **Rollback:** retain per-ref requests.

## Implemented before/after

| Change | Exact UX result | Controlled protocol change | p95 |
| --- | --- | --- | --- |
| Remove discarded kind 7 from authored notifications | displayed IDs 2/2 before and after; same sync/fan-out | 4→4 REQ, 8→6 deliveries, authored request 121→119 bytes | 42→39 ms |
| Query extra quote hint once | quote IDs 2/2 before and after; same fallback and hint fan-out | 6→5 REQ, 4→3 deliveries, hint REQ 2→1 | 27→23 ms |

## Decision

R-NE-1 and R-NE-2 are implemented with exact before/after no-UX-tradeoff transcripts. R-NE-3 has a proven duplicate mechanism but needs subscription-lifetime ownership tests before implementation. R-NE-4 is correctness work that may increase relay usage. R-NE-5 remains measurement/prototype work. No relay, age, limit, cache-freshness, or metadata coverage reduction is recommended.
