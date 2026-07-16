# Feed, bootstrap, and refresh relay audit

Issue: [#74](https://github.com/smolgrrr/wired-admin/issues/74)

Audited branches: Wired `codex/relay-efficiency-improvements`; wired-admin `codex/relay-efficiency-audit`

Evidence: [`feed-local-2026-07-14`](relay-audit-data/feed-local-2026-07-14.json)

## Outcome

The browser live feed, Wired server snapshot, and wired-admin refresh all resolved the exact three-ID recursive fixture through two relays, deduplicated relay results, and matched every finite REQ with EOSE/CLOSE. The browser retained its two shared pooled connections until fixture teardown; both server refreshes closed their per-refresh sockets. Both server refresh owners coalesced two simultaneous in-process callers into one fetch. No controlled scenario contacted a public relay.

The audit found no safe reason to narrow relay coverage, age, reply depth, parent count, or result limits. In fact, the current depth/parent/result caps cannot prove the required complete-feed contract. The clearest no-UX-tradeoff work is lifecycle work. A browser disconnect fixture exposed a stale pooled relay that blocked recursive feed completion and then threw while opening the next query; the branch now settles its subscriptions, removes it from the pool, and resolves the exact 3-ID result in 30 ms. Both server snapshot implementations can still outlive their configured connection deadline or wait for EOSE after a relay is terminal. Browser/bootstrap overlap and the existence of two independently scheduled snapshot producers may be waste, but their real multiplicity is unknown and must be measured before consolidation.

## Workflow map

```text
Browser mount
  ├─ HTTP bootstrap lookup (external, then Vercel fallback; cached/coalesced)
  │   └─ finite reply traversal for snapshot roots
  └─ live activity subscription
      ├─ missing-root resolution with tag/NIP-19 hints
      └─ finite recursive reply traversal

Wired cron/API refresh                 wired-admin startup/timer/API/moderation refresh
  └─ coalesced snapshot fetch             └─ coalesced snapshot fetch
      ├─ activity                              ├─ activity + cached carry-forward
      ├─ missing roots + hints                 ├─ missing roots + hints
      ├─ recursive replies                     ├─ recursive replies
      ├─ referenced events/replies             ├─ referenced events/replies
      └─ profiles                              └─ profiles + atomic disk persist
```

## Operation inventory

Each row uses nostr-tools 2.5.1 in Wired and 2.23.8 in wired-admin. All relay lists are normalized/deduplicated before use unless noted.

| ID | Purpose and trigger | Filter / relay coverage / fan-out | Lifecycle, batching, caching, dedup, result contract | Evidence and UX invariant |
| --- | --- | --- | --- | --- |
| FED-B0 | Browser bootstrap first paint on eligible default settings. | No direct relay operation: sequential HTTP external snapshot then `/api/feed/bootstrap`, 3,000/800 ms aborts. | Module coalesces simultaneous callers and positively caches the snapshot for the session. Failure falls through to live relay results. | `feedBootstrapClient.ts:13-120`, `useFeed.ts:249-291`. It may accelerate but never suppresses live coverage. |
| FED-B1 | Live root/activity discovery on feed mount, mode/age/difficulty change. | `{kinds:[1], since:age, limit:500}` over configured PoW relays. One finite subscription per connected relay. | Shared pooled connections; close on per-relay EOSE/client EOSE timeout; event IDs deduped in React. Initial EOSE gates root planning. | `global-feed.ts:239-319`. Cold fixture: two relays, 2 REQ, 2 root deliveries/1 unique root; initial-content p50/p95 7/26 ms. Preserve all configured roots and live fallback. |
| FED-B2 | Resolve a qualifying activity event's missing thread root, including chained reply activity. | Exact ID batches of 20, kind 1, `limit=ids.length`; union of reply/configured relays and event/tag hints. Root resolution depth is statically bounded. | Sequential chunks, finite EOSE close, requested-ID dedup for one workflow. Failures from one relay do not prevent another. | `global-feed.ts:98-196`, `feed-candidates.ts`. A 21-root fixture used exact 20+1 chunks and resolved 42/42 activity/root IDs through a distinct preconnected NIP-10 hint. A newly discovered hint is selected but not dynamically connected; see F-FEED-8. |
| FED-B3 | Resolve replies for live roots. | Parent batches of 20 inside a first-50 parent cap; `{#e, kinds:[1], since, limit:100}` over configured thread relays; maximum depth 2. | Sequential chunks and depths; finite close on aggregate EOSE; owner closes pending work on unmount. Event IDs deduped downstream. | `global-feed.ts:42-96,198-237`, `query-limits.ts:3-47`. Baseline full workflow: 6 REQ/6 CLOSE, 6 deliveries/3 unique IDs, p50/p95 completion 28/50 ms. The 21-root edge started 21 individual two-relay traversals (42 reply REQ); batching requires timing evidence. Caps do not prove completeness. |
| FED-B4 | Enrich roots supplied by bootstrap while live discovery proceeds. | Same reply filter/coverage as FED-B3, rooted at snapshot IDs. | Separate finite traversal starts as soon as bootstrap loads and is cleaned on root-key/unmount change. Results merge with snapshot/live IDs. | `useFeed.ts:331-362`. With bootstrap starting 10 ms after live and relay events at 15 ms, both paths resolved the exact 2-reply set: 8 REQ/EOSE/CLOSE, 8 deliveries, 59 ms complete. This proves mechanism overlap, not ordinary frequency; removing either path could delay replies. |
| FED-W0 | Wired server bootstrap cache read and refresh. GET serves cache; Vercel cron runs `0 4 * * *`. | Cache hit has no relay work. Miss refresh is disabled on production reads; authorized cron owns refresh. | `FeedBootstrapCacheService` coalesces concurrent callers per process and writes memory/Vercel stores. CDN TTL 120 s, SWR 300 s; data-store TTL 300 s. Cross-instance coalescing is not established. | `feedBootstrapCache.ts:90-211`, `handlers.ts:111-159`, `vercel.json`. Twenty cron-handler/direct-refresh collisions each produced one transcript/snapshot object. Cached first paint must remain available during refresh. |
| FED-W1 | Wired server activity discovery per refresh. | Same activity shape, selected PoW targets within the configured snapshot connections. | New direct connections per refresh; finite query; deduped event IDs and relay hints. | `feedSnapshot.ts:279-386`. Baseline uses two relays and exact duplicate suppression. Connection timeout argument is not applied to `Relay.connect`. |
| FED-W2 | Wired server missing-root resolution. | Exact pending IDs; configured snapshot relays plus hints; kind 1, exact limit; bounded root-resolution depth. | Opens/closes a fresh direct-relay set for each resolution round; requested-ID dedup. | `feedSnapshot.ts:207-278`. Preserve all hints and root identity; no baseline query because activity was a root. |
| FED-W3 | Wired server root reply closure. | `{#e, kinds:[1], since, limit:100}` over reply relays, first 50 parents, max depth 2. | Reuses activity connections across sequential depths; finite query per depth. | Baseline: two depth queries × two relays. All 3 IDs resolved; p50/p95 whole snapshot 34/52 ms. Depth/parent/limit caps are incomplete by construction. |
| FED-W4 | Wired server referenced notes and their replies. | Exact IDs kinds `[1,1068]` across configured plus reference hints, followed by the same bounded reply traversal. | Fresh direct connections for referenced coverage; known-ID dedup; sequential depths. | `feedSnapshot.ts:386-460`. The context fixture resolved 2/2 root/reference IDs and asserted the exact reference filter. Required quoted/context events remain part of completeness. |
| FED-W5 | Wired server profile metadata for root/reply/reference authors. | Batched authors, kind 0, limit equal to capped author count, configured profile relays. | Fresh direct connections after event work; newest `created_at` per pubkey wins. | `feedSnapshot.ts:461-548`. Competing events from two relays selected the newest profiles for both authors deterministically. Required metadata must not be removed or served stale. |
| FED-A0 | wired-admin startup, interval, authorized API, cache-miss, and moderation-triggered refresh. | Trigger paths converge on one service; interval defaults to 300 seconds. | A single `refreshPromise` coalesces overlap in-process; previous disk snapshot loads before startup refresh; successful output is persisted atomically at service boundary. The exported scheduler owns the interval boundary. | `server.ts:1499-1536`, `http-routes.ts:139-170,286-311`, `feed-snapshot-service.ts`. Twenty controlled one-millisecond interval/manual collisions each produced one 8-REQ transcript. Cross-process overlap is not established. |
| FED-A1 | wired-admin activity plus cached carry-forward. | `{kinds:[1], since, limit:500}` on PoW relays; previous snapshot events inside age or retained roots are merged. | One fresh union connection set for feed phases; event/relay-hint dedup. | `feed-snapshot-service.ts:728-790,979-1043`. Baseline returned each root twice/one unique; an immediate incremental refresh with zero fresh activity retained the exact prior 3-ID snapshot. Preserve fresh activity and valid cached first paint. |
| FED-A2 | wired-admin missing-root resolution. | Exact ID queries over enrichment/thread base plus event hints, iterative but bounded by `replyFetchDepth+1`. | New direct connections per missing-ref batch; attempted-ID dedup; finite EOSE/timeout. | `feed-snapshot-service.ts:631-727`. No extra root query in baseline; hints and chained activity remain mandatory. |
| FED-A3 | wired-admin reply closure for feed and referenced events. | Parent chunks of 50; `{#e, kinds:[1], since, limit:configured replyLimit}`; configured depth. | Sequential depth/chunk queries over reused feed connections or referenced connections; ID/hint dedup. | `feed-snapshot-service.ts:595-630,765-790,891-932`. Two-depth baseline resolved 3/3 IDs; caps remain completeness gaps. |
| FED-A4 | wired-admin referenced-event enrichment. | Exact missing IDs kind 1 over configured base plus hints, then FED-A3. | Known-ID suppression; direct connections owned per reference group. | `feed-snapshot-service.ts:631-727,891-932`. A distinct hinted relay supplied the missing reference; the fixture resolved the exact 2-ID set over all three selected relays. Required context cannot be dropped to save queries. |
| FED-A5 | wired-admin profile refresh. | All output pubkeys, kind 0, `limit:1` per author via one batched filter over enrichment relays. | Fresh direct connections; newest profile selected and merged over cached profiles. | `feed-snapshot-service.ts:933-978,1015-1028`. Competing profile events selected the newest metadata for both authors. Requery frequency may be optimizable only with freshness evidence. |

## Controlled measurements

| Workflow | Samples | Exact output | Per-run relay work | Local timing |
| --- | ---: | --- | --- | --- |
| Browser cold global feed | 20 | 3/3 IDs, including immediate-parent-only nested reply | 2 connections; 6 REQ/EOSE/CLOSE; 6 deliveries/3 unique; fan-out 2 | initial p50/p95 7/26 ms; complete 28/50 ms |
| Browser 21 missing roots + distinct hint | 1 | 42/42 activity/root IDs | 50 REQ/EOSE/CLOSE; 63 deliveries; fan-out 3; exact root chunks 20+1 | controlled edge only; 42 REQ were per-root reply traversals |
| Browser peer disconnect | 1 before/after | Before: no completion and a closed-connection exception. After: 3/3 IDs | After: 4 REQ, 3 EOSE/CLOSE, 3 deliveries; fan-out 2 | after: 30 ms |
| Browser bootstrap/live overlap | 1 | Both paths resolved the same exact 2-reply set | 8 REQ/EOSE/CLOSE; 8 deliveries; fan-out 2 | bootstrap +10 ms, complete 59 ms |
| Wired cron/manual cache refresh | 20 | 3/3 IDs; cron-handler and direct caller received the same coalesced snapshot | 4 connections; 8 REQ/EOSE/CLOSE; 6 deliveries/3 unique; fan-out 2 | complete p50/p95 34/52 ms |
| Wired server reference + metadata | 1 | 2/2 context IDs and newest 2/2 profiles | 10 REQ; fan-out 2 | deterministic fixture |
| Wired server no-EOSE relay | 1 | 3/3 IDs from the responsive relay | 8 REQ; 4 relay EOSE plus 4 client timeout completions | 214 ms with a 50 ms per-phase deadline |
| wired-admin scheduled/manual refresh | 20 | 3/3 IDs; interval and manual caller received the same coalesced snapshot | 4 connections; 8 REQ/EOSE/CLOSE; 6 deliveries/3 unique; fan-out 2 | complete p50/p95 33/48 ms |
| wired-admin incremental carry | 1 | 3/3 prior IDs with zero fresh activity | finite refresh; unchanged identity | deterministic fixture |
| wired-admin reference + metadata | 1 | 2/2 context IDs and newest 2/2 profiles | 12 REQ; fan-out 3 including distinct hint | deterministic fixture |
| wired-admin no-EOSE relay | 1 | 3/3 IDs from responsive relay | 8 REQ; 4 relay EOSE plus 4 client timeout completions | 50 ms per-phase deadline |

The raw file retains samples, request/event bytes, lifetimes, peak subscriptions, EOSE-versus-timeout, coalescing, and protocol identity. Unit fixtures establish comparable control behavior, not real relay load or production latency.

## Findings

### F-FEED-1 — reply and root-resolution bounds violate the completeness contract

This is a static correctness defect across browser, Wired server, and wired-admin. Depth 2, first-50 parents, and `limit:100` can omit reachable descendants. wired-admin's first-paint root/reply projection is intentionally smaller and is acceptable only because the browser live path fills it; the live path is itself bounded. No observed production thread-size distribution was inferred.

### F-FEED-2 — server connection deadlines are not actually owned

Wired's `connectRelays(urls, timeoutMs)` ignores `timeoutMs` and inherits nostr-tools' 4.4-second connection behavior. wired-admin's direct Relay.connect has no application connection timeout in nostr-tools 2.23.8. A late connection can also escape the phase that later closes the collected relay array. In wired-admin, one unresolved connection keeps `refreshPromise` pending and coalesces every later trigger onto the hung refresh. This is static dependency/application evidence.

### F-FEED-3 — terminal relay close waits for query timeout and retains EOSE timers

Both server `subscribeOnce` implementations count only EOSE (or synchronous subscribe throw). A connection that closes after subscribe remains outstanding until the application timer. nostr-tools subscription close does not itself clear its EOSE timer in Wired 2.5.1; terminal cleanup must own it explicitly. This matches the independently measured preview mechanism, but feed-specific before/after timing still needs a degraded fixture before claiming an improvement.

### F-FEED-4 — browser bootstrap/live reply overlap is mechanically demonstrated; ordinary frequency is unknown

FED-B4 and FED-B3 targeted the same root in the controlled slow-bootstrap permutation. Both independently resolved the exact two-reply set, producing 8 requests where one traversal alone would produce 4. Order still depends on HTTP bootstrap timing, live EOSE, snapshot contents, and relay response; no ordinary overlap rate is inferred. The current paths protect first-paint and authoritative live completion. Do not remove either without an explicit ownership handoff.

### F-FEED-5 — two snapshot producers may duplicate refresh work

Wired cron/serverless refresh and wired-admin startup/timer/API refresh implement nearly the same relay sequence. Actual simultaneous cadence, deployed ownership, cache consumers, and relay configuration are not present in the repository evidence. This is an architecture/runtime hypothesis for ticket #77, not a savings claim.

### F-FEED-6 — in-process overlap is already coalesced

Both implementations return their active refresh promise. Twenty controlled runs with two simultaneous callers produced one set of connections/REQ and the exact same snapshot object. Additional in-process debouncing would not reduce this demonstrated overlap.

### F-FEED-7 — a terminal browser relay blocked and then broke recursive feed traversal (fixed on the audit branch)

The controlled peer-disconnect run initially exceeded the 5,000 ms test deadline and then threw `sending on closed connection` when the next reply query reused the stale pooled relay. The pool now removes a terminal relay and calls `receivedEose()` on its open subscriptions before nostr-tools closes them. The same fixture resolves 3/3 IDs in 30 ms, with no target/filter narrowing. Healthy-relay transcript identity is unchanged.

### F-FEED-8 — newly discovered browser relay hints are selected but not connected

`FeedRootFetch` includes NIP-10/NIP-19 hints in each root query's `relayUrls`, but `RelayPool.subscribe` can only use relay objects that were already connected. The 21-root controlled fixture had to preconnect its distinct hinted relay to demonstrate the 20+1 root chunks. In an ordinary session, a hint outside configured/previously connected relays is silently absent from the actual fan-out. This is a feed completeness defect, not a relay-saving opportunity.

### F-FEED-9 — resolved browser roots start reply traversals one at a time

The 21-root controlled edge generated 42 reply REQ because each resolved root immediately starts its own traversal over two relays. A grouped two-chunk traversal would be narrower, but grouping at root EOSE could delay replies that arrive before EOSE. The observed request count is controlled evidence; a production saving or safe batching window is not inferred.

## Recommendation records

### R-FEED-1 — own finite-query connections and terminal settlement

1. **Identity/ownership:** FED-W1–W5 and FED-A1–A5; respective server feed owners.
2. **Evidence:** F-FEED-2/3 and exact nostr-tools behavior; no feed-specific reduction is claimed before degraded before/after transcripts.
3. **Change:** apply the configured deadline to each connection attempt, close late arrivals, clear application timers, count subscription terminal close/error with EOSE, and clear library EOSE timers before returning. Keep targets, filters, deadline duration, and result aggregation identical.
4. **Expected impact:** unchanged REQ/fan-out on healthy relays; bounded refresh completion, fewer late sockets/stale timers, and removal of waiting after all targets are terminal.
5. **Confidence:** high for lifecycle correctness; medium for real frequency because no production failure rate is known.
6. **UX invariants:** identical IDs/metadata/coverage, unchanged maximum deadline, partial-relay success, normal p95 no worse than baseline, degraded path completes only after every target is EOSE/terminal/deadline.
7. **Rejected alternatives:** shorter timeout, first-success, or fewer relays can omit results; permanent pooling changes server lifecycle and needs architecture evidence.
8. **Verification:** normal, delayed, close-before-EOSE, connect-after-deadline, no-EOSE, all-fail; exact filters/result IDs; controlled clocks; 20-run normal/degraded comparison.
9. **Rollout:** isolated per implementation; observe refresh failures, duration, event/profile counts, socket handles; stop on any completeness or p95 regression.
10. **Rollback:** revert lifecycle helper while retaining failure tests and measurement hooks.

### R-FEED-2 — replace silent reply bounds with complete chunked traversal

1. **Identity/ownership:** FED-B2–B4, FED-W2–W4, FED-A2–A4; shared domain behavior.
2. **Evidence:** F-FEED-1; deterministic caps, not a claim that omission happens frequently in production.
3. **Change:** prototype an explicit frontier/chunk traversal with no arbitrary depth/parent omission, relay EOSE/timeout state, exact-ID dedup, and live handoff for browser paths. Define how relay result limits are paged or proven exhausted.
4. **Expected impact:** correctness first and potentially more relay work. Any later split-filter/dedup optimization must be measured independently.
5. **Confidence:** high that caps cannot prove completeness; medium on the final traversal design.
6. **UX invariants:** every reachable root/reply/reference/profile through unchanged coverage; no first-content or completion p95 regression beyond an explicitly approved target; cleanup on navigation/refresh.
7. **Rejected alternatives:** smaller age/depth/limits, top-N roots, first relay, or snapshot-only results silently trade UX for traffic.
8. **Verification:** >2 depth, >50 parents, >100 replies, same-second arrivals, duplicate relays, hints, missing EOSE, cache hit/miss, exact set equality and bytes/REQ comparison.
9. **Rollout:** prototype and staging flag; stop on missing IDs, unbounded active subscriptions, or p95 regression.
10. **Rollback:** disable the new traversal and preserve the known completeness defect for follow-up rather than silently narrowing output.

### R-FEED-3 — measure bootstrap/live overlap before deduplicating it

1. **Identity/ownership:** FED-B0/B3/B4; browser feed owner.
2. **Evidence:** the controlled overlap duplicated one exact two-depth traversal (8 versus 4 REQ); ordinary frequency/order remain unknown.
3. **Change:** correlate bootstrap completion, live initial EOSE, root IDs, filters, and per-path result arrival during ordinary sessions. Only then design cancellation or shared traversal with an explicit ownership handoff.
4. **Expected impact:** unknown; metric is duplicate REQ/bytes for the same root/depth while preserving earlier result time.
5. **Confidence:** low on savings, high that measurement is required.
6. **UX invariants:** bootstrap replies remain timely; live authoritative coverage remains complete; handoff has no delivery gap.
7. **Rejected alternatives:** removing bootstrap enrichment regresses first paint; suppressing live enrichment trusts stale/bounded snapshots.
8. **Verification:** slow bootstrap/live permutations, cache hit/miss, duplicate and disjoint root sets, exact IDs, initial/completion p95.
9. **Rollout:** instrumentation first; any handoff behind a flag with per-path counters.
10. **Rollback:** disable shared ownership and restore both independent traversals.

### R-FEED-4 — decide one snapshot architecture only after deployment evidence

1. **Identity/ownership:** FED-W0–W5, FED-A0–A5, architecture ticket #77.
2. **Evidence:** duplicated implementations and schedules are static; deployed duplication is unknown.
3. **Change:** document consumers/SLAs, capture ordinary trigger/cadence/relay transcripts, then choose one owner or justify both. A shared implementation must preserve cache availability and failure isolation.
4. **Expected impact:** unknown until deployed overlap is observed; measure removed refreshes/connections/REQ, not guessed relay load.
5. **Confidence:** low on operational duplication, high on code duplication.
6. **UX invariants:** no bootstrap availability regression, same relay coverage/results/metadata freshness, independent recovery from owner failure.
7. **Rejected alternatives:** deleting either producer from code inspection alone risks an unavailable bootstrap; cross-process locks add complexity without evidence.
8. **Verification:** consumer map, staging failover, equivalent snapshots/transcripts, cadence and cache hit measurements.
9. **Rollout:** architecture decision with staged consumer migration and dual-read comparison.
10. **Rollback:** route consumers back to the previous producer and retain its cache until equivalence is established.

### R-FEED-5 — connect dynamic browser hints without delaying configured coverage

1. **Identity/ownership:** FED-B2 and browser relay pool; feed-root owner.
2. **Evidence:** F-FEED-8 and the distinct-hint transcript; production frequency is unknown.
3. **Change:** start the configured-relay exact-ID query immediately, connect newly discovered normalized hints under the same owner, and query late successful hints only for still-missing IDs. Deduplicate relay/ID attempts and close late work on navigation.
4. **Expected impact:** potentially more connections/REQ only where a new hint adds required coverage; improved root completeness. No savings claim.
5. **Confidence:** high in the static omission, unknown frequency.
6. **UX invariants:** configured coverage and first-result timing do not wait for hint connection; every successful hinted result is delivered; no duplicate event delivery.
7. **Rejected alternatives:** awaiting all hints delays configured coverage; ignoring hints violates completeness; replacing configured relays with hints narrows redundancy.
8. **Verification:** connected/unconnected/delayed/failing hint, navigation cleanup, duplicate normalized URLs, chained root refs, exact IDs and p95.
9. **Rollout:** isolated feed-root path with counters for hint discovered/connected/queried/resolved.
10. **Rollback:** disable dynamic hint connections while preserving the explicit completeness finding.

### R-FEED-6 — measure a zero-delay root batching handoff

1. **Identity/ownership:** FED-B2/B3; browser root-to-reply handoff.
2. **Evidence:** F-FEED-9: 42 reply REQ for 21 roots over two relays.
3. **Change:** prototype grouping roots delivered in the same task/microtask before starting reply chunks; never wait for relay EOSE or an arbitrary debounce.
4. **Expected impact:** lower REQ when roots arrive in bursts; unchanged filters/coverage. Production frequency is unknown.
5. **Confidence:** high in controlled duplication, low in real savings and timing equivalence.
6. **UX invariants:** no measurable first-reply/completion p95 regression; exact descendants and cleanup.
7. **Rejected alternatives:** EOSE/debounce batching can delay timely replies; dropping roots or relays trades completeness.
8. **Verification:** synchronous and staggered root arrival, slow/no EOSE, 20/21/50/51 roots, exact sets, initial/completion timing.
9. **Rollout:** prototype first; ship only if timing is equivalent and controlled REQ falls.
10. **Rollback:** retain per-root traversal.

## Decision

The browser portion of lifecycle ownership in F-FEED-7 is implemented and verified as a clear no-UX-tradeoff correction. R-FEED-1 remains the clear server implementation candidate, now backed by feed-specific no-EOSE fixtures in both repositories. R-FEED-2 and R-FEED-5 are required correctness work and may increase relay work. R-FEED-3, R-FEED-4, and R-FEED-6 remain measurement/architecture work; none is authorized as a relay-saving change from current evidence.
