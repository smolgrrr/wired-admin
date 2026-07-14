# Notification and enrichment relay audit

Issue: [#75](https://github.com/smolgrrr/wired-admin/issues/75)

Audited branches: Wired `codex/relay-efficiency-improvements`; wired-admin `codex/relay-efficiency-audit`

Evidence: [`notification-enrichment-local-2026-07-14`](relay-audit-data/notification-enrichment-local-2026-07-14.json), with the one-shot context baseline reused from [`thread-local-2026-07-14`](relay-audit-data/thread-local-2026-07-14.json).

## Outcome

The notification path resolved the exact authored, tagged, duplicate-match, and peer-disconnect fixture through two local relays. Profile enrichment used one author batch, received competing metadata from both relays, and selected the newest inputs deterministically. Quote enrichment resolved fallback and delayed hinted events, completed an empty result behind a stale hint, and cleaned every opened finite subscription. No controlled scenario contacted a public relay.

Two controlled findings are clear no-UX-tradeoff candidates. First, notification queries request kind-7 reactions, but `useFilteredNoteSubscription` immediately discards every event except kinds 1 and 1068, so reaction delivery cannot affect the current UI. Second, an already-connected extra quote hint receives the identical exact-ID query twice. Both can be removed without narrowing the displayed event set or relay coverage. Profile batching prevents same-task duplicates, but a consumer mounted while the first request is still live starts the same pubkey query again; fixing that requires owning the subscription until EOSE rather than merely until its handle is created.

The audit found no safe basis for adding a notification `since`, reducing relay coverage, lowering limits, suppressing fallback queries, or making quoted context/profile metadata best-effort. Notification limits and the 250-profile cap are completeness risks, not opportunities to do less work.

## Operation inventory

| ID | Purpose and trigger | Filter / relay coverage | Lifecycle, batching, cache, dedup | Evidence and UX invariant |
| --- | --- | --- | --- | --- |
| NOT-1 | “Your transmissions” and authored activity when notification page mounts or local keys change. | `{authors:pubkeys, kinds:[1,7], limit:25}` over the initialized default relay pool. No time boundary. | One finite subscription per connected relay; close on aggregate EOSE. The hook deduplicates IDs, then drops kind 7 before rendering. | `notifications.ts`, `useNotificationEvents.ts`, `useFilteredNoteSubscription.ts`, `noteEvents.ts`. Preserve every displayed authored note and completion state. Kind 7 is unobservable in this UI. |
| NOT-2 | Mentions of any local key in the same page lifecycle. | `{#p:pubkeys, kinds:[1], limit:50}` over the same pool. No time boundary. | Independent finite subscription; notification sync becomes `synced` only after NOT-1 and NOT-2 aggregate EOSE. Eight-second UI timer marks degraded without cancelling results. | Controlled normal path: 4 total REQ/EOSE/CLOSE over two relays, 8 deliveries/3 raw IDs/2 displayed note IDs, p50/p95 completion 36/42 ms. Preserve authored/tagged union and partial results. |
| ENR-1 | Profile for every `PostCard`, quote, inline `npub/nprofile`, and reply context. | One `{authors:[pending], kinds:[0], limit:min(authors,250)}` filter over profile/thread relays. | Module-global positive cache; same-microtask consumers batch and cached pubkeys skip relay work. Newest `created_at` wins. There is no negative cache. `inflightBatch` ends when the subscription handle is created, not at EOSE. | `useProfiles.ts`, `subscriptions/index.ts`. Controlled two-author batch: 2 REQ, 4 deliveries, newest 2/2 inputs. Runtime hook test: two same-task consumers made one request; a third consumer mounted before a profile response caused a second identical pubkey request. Preserve timely newest metadata. |
| ENR-2 | Exact earlier/context notes referenced by the thread OP. | `{ids:eventIds, kinds:[1], limit:eventIds.length}` over all thread relays. | One finite multi-ID subscription; hook-level ID dedup. No tag relay hints are forwarded. | `useThreadViewModel.ts`, `subNotesOnce`. Reused 20-run baseline: 2 REQ over two relays, p50/p95 17/19 ms, exact context result. Preserve earlier context identity. |
| ENR-3 | First attempt to satisfy quoted `note/nevent/naddr` references used by `PostCard` bodies. | Browser first loads the coalesced/positively cached feed bootstrap snapshot over HTTP; snapshot hits create no relay request. Missing refs continue to ENR-4. | Per-hook state deduplicates IDs; bootstrap profiles seed the global profile cache. A failed bootstrap falls through to relays. | `useQuotedEvents.ts`, `feedBootstrapClient.ts`. Preserve snapshot first paint and live fallback; a snapshot miss must never suppress relay lookup. |
| ENR-4 | Relay fallback for each quote missing from snapshot. | One exact `{ids:[id], kinds:[1,1068], limit:1}` request per ref over PoW plus default/configured quote fallback relays. The request's relay list also includes the ref hint, but unconnected hints are skipped by the pool. | Finite close on EOSE. Ref completion is reported from fallback only when no extra hint exists. Different quote refs are not batched. | Three-ref fixture: fallback quote, hinted quote, and missing/stale-hint quote resolved 2/3 with explicit completion for all three. Preserve fallback first-result timing and missing-state accuracy. |
| ENR-5 | Extra relay hints from `nevent/naddr` or tags. | After fallback starts, connect distinct hints, then issue the same per-ref exact filter over extra hints. | Owner closes late-added handles after unmount. Stale hint failure yields zero protocol request and still completes the ref. If the extra hint was already connected, ENR-4 already queried it and ENR-5 queries it again. | Preconnected-hint fixture: 3 REQ over fallback+hint; the hint received the identical filter twice and returned the same event twice/one unique ID. Preserve hinted coverage and fallback-first behavior. |

## Controlled measurements

| Workflow | Samples | Exact output | Local relay work | Timing |
| --- | ---: | --- | --- | --- |
| Notifications normal | 20 | 3/3 raw IDs; 2/2 kinds currently displayed | 4 REQ/EOSE/CLOSE; 8 deliveries/3 unique; fan-out 2 | complete p50/p95 36/42 ms |
| Notifications peer disconnect | 1 | 3/3 raw IDs from healthy peer | 4 REQ; 4 deliveries; 2 healthy EOSE; fan-out 2 | deterministic degraded fixture |
| Profiles | 1 | 2/2 pubkeys; newest 2/2 inputs | 2 REQ/EOSE/CLOSE; 4 deliveries; fan-out 2 | deterministic fixture |
| Quotes fallback/hint/missing | 1 | fallback + hinted resolved; missing ref explicitly completed | 7 REQ/EOSE/CLOSE; 3 deliveries/2 unique; fan-out 3 | hint event 20 ms, EOSE 25 ms |
| Quote with preconnected extra hint | 1 | 1/1 ID | 3 REQ; 2 deliveries/1 unique; same hint/filter twice | deterministic duplicate fixture |
| One-shot thread context | 20 | exact required context | 2 REQ/EOSE/CLOSE; 1 delivery; fan-out 2 | complete p50/p95 17/19 ms |

These timings and counts are fixture baselines, not estimates of production relay load, cache hit rates, notification volume, or latency.

## Findings

### F-NE-1 — kind-7 notification results are queried and then unconditionally discarded

NOT-1 requests kinds 1 and 7. Its only production consumer passes the results through `filterNoteEvents`, which retains kinds 1 and 1068, and the notification page cannot observe reaction events. In the controlled run, each relay returned one kind-7 event that contributed no displayed result. Removing kind 7 changes the exact filter and returned bytes, but not the rendered notification set or sync lifecycle.

### F-NE-2 — notification limits cannot prove complete activity

NOT-1 has `limit:25` and NOT-2 has `limit:50`, without pagination or a persisted cursor. Both span all time. This bounds returned volume but can omit older authored/mentioned activity and makes “accurate notifications” dependent on relay ordering. Adding `since`, lowering limits, or first-relay completion would worsen the contract. A cursor/pagination design is correctness work and may increase requests.

### F-NE-3 — an already-connected extra quote hint receives the same query twice

ENR-4 includes `ref.relays` in its requested relay list. ENR-5 separately identifies those same non-fallback hints and queries them after `ensureRelaysConnected`. When a hint is already connected, both paths target it. The controlled hint received two byte-identical exact-ID filters and returned the same event twice. Fallback relays and hinted coverage can remain unchanged by excluding extra hints from the initial fallback target list; unconnected hints already behave that way in practice.

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

## Decision

R-NE-1 and R-NE-2 are clear implementation candidates with exact no-UX-tradeoff transcripts. R-NE-3 has a proven duplicate mechanism but needs subscription-lifetime ownership tests before implementation. R-NE-4 is correctness work that may increase relay usage. R-NE-5 remains measurement/prototype work. No relay, age, limit, cache-freshness, or metadata coverage reduction is recommended.
