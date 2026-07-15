# Prioritized relay-efficiency implementation plan

Issue: [#78](https://github.com/smolgrrr/wired-admin/issues/78)

## Source of truth

This plan links rather than repeats the detailed evidence:

- [Audit rubric](relay-audit-rubric.md) — definitions, proof standard, Nostr semantics, and recommendation template.
- [Transcript method](../relay-transcript-harness.md) — deterministic loopback relay and workflow summary contract.
- [Thread and preview audit](thread-preview-relay-audit.md) — THR-B1–B3 and THR-S1–S2.
- [Feed, bootstrap, and refresh audit](feed-refresh-relay-audit.md) — FED-B0–B4, FED-W0–W5, and FED-A0–A5.
- [Notification and enrichment audit](notification-enrichment-relay-audit.md) — NOT-1/2 and ENR-1–5.
- [Publishing audit](publishing-relay-audit.md) — PUB-1–6.
- [Architecture decision](relay-access-architecture.md) — repo-local deep lifecycle modules, workflow-local semantics, separate publishing ownership, compatibility, alternatives, and migration rules.

All measurements below are controlled loopback regression evidence. They are not estimates of public relay traffic, load, latency, or capacity.

## Priority rules

1. Preserve configured and hinted relay coverage, every reachable reply and required metadata item, exact accepted-relay behavior, and measured timeliness.
2. Land already-proven reductions and lifecycle fixes before adding infrastructure.
3. Prefactor transport ownership without changing filters/results before completeness or batching changes.
4. Treat reply/context/profile completeness defects as higher priority than traffic reduction even when the fix adds relay work.
5. Require ordinary status evidence before optimizing runtime-sensitive overlap.
6. Make every slice independently releasable and rollbackable; no ticket combines a lifecycle extraction with a changed traversal/filter contract.

## Dependency order

| Order | Slice | Blocked by | Unlocks |
| ---: | --- | --- | --- |
| 0 | S0 land reviewed audit fixes and transcript coverage | — | S1 |
| 1 | S1 versioned workflow status/evidence contract | S0 | S2–S4, S9–S12 |
| 2 | S2 deepen Wired browser finite-query ownership | S1 | S6, S7 browser tickets, S8, S11 browser experiments |
| 2 | S3 extract Wired server finite relay sessions | S1 | S5, S7 Wired-server tickets |
| 2 | S4 extract wired-admin finite relay sessions | S1 | S7 wired-admin tickets |
| 3 | S5 restore recursive server-preview completeness | S3 | — |
| 3 | S6 connect dynamic browser hints | S2 | — |
| 3 | S7 prototype and implement complete reply/frontier traversal per workflow | S2–S4 | — |
| 3 | S8 own profile requests through EOSE | S2 | S9P |
| 4 | S9N notification cursor/history; S9P profile chunking | S9N: S1; S9P: S8 | — |
| 4 | S10 observe/decide, then bound browser publish completion | S1 | — |
| 4 | S11 run timing-equivalent batching/handoff experiments | S1 and S2 | — |
| 4 | S12 measure deployment-level duplicate producers/callers | S1 | — |

S2, S3, and S4 can run in parallel after their repo-specific S1 prerequisites because they change different runtime owners. S5/S6/S8 can then run independently. This group table is explanatory only; native blocking edges must follow the authoritative ticket-level matrix below.

### Required agent-sized ticket decomposition

Numbered slices are planning groups, not permission to create epic-sized implementation tickets:

- **S1:** S1a versioned schema/conformance fixture only; S1b Wired repo-local bounded collector plus browser-publication end-to-end adapter; S1c wired-admin repo-local bounded collector plus server-publication end-to-end adapter; S1d Wired bounded operational exporter/ingest; S1e wired-admin bounded operational exporter to the same aggregate contract. Later workflow tickets add their own fields rather than a separate “instrument everything” ticket.
- **S2:** S2a browser interface/internal adapter tests; then one migration ticket each for root, context, notification, quote, and profile finite queries; finally one old-path deletion ticket after all migrations.
- **S3:** S3a Wired server interface/internal adapter tests; S3b preview migration; S3c snapshot activity/reply phases; S3d snapshot reference/profile phases; final duplicated-helper deletion.
- **S4:** S4a wired-admin interface/internal adapter tests; S4b activity/reply phases; S4c reference/profile phases; S4d scheduler/API cancellation and final old-helper deletion.
- **S7:** S7a bounded interface/algorithm prototype and go/no-go decision; only after approval, one implementation ticket each for browser thread, browser feed, Wired server snapshot, and wired-admin snapshot. S5 owns preview separately.
- **S9:** S9N notification cursor/history design and implementation are separate from S9P profile >250 chunking; S9N design must settle its UI/history contract before its implementation ticket.
- **S10:** S10a bounded status observation and deadline/late-ACK decision; S10b production implementation blocked by the approved S10a contract.
- **S11/S12:** one ticket per experiment/investigation. A go decision produces a new production ticket; it does not expand the investigation ticket.

### Authoritative ticket-level blocker matrix

The group table above explains ordering only. `/to-tickets` must use these exact native edges and must not create S1/S2/S3/S4 umbrella blockers:

| Ticket | Blocked by |
| --- | --- |
| S0 land audit PRs | — |
| S1a schema/conformance fixture | S0 |
| S1b Wired collector + browser-publish adapter | S1a |
| S1c wired-admin collector + server-publish adapter | S1a |
| S1d Wired operational aggregate export/ingest | S1b |
| S1e wired-admin operational aggregate export | S1c, S1d ingest contract |
| S2a browser finite-query interface/adapter tests | S1b |
| S2b root finite-query migration | S2a |
| S2c context finite-query migration | S2a |
| S2d notification finite-query migration | S2a |
| S2e quote finite-query migration | S2a |
| S2f profile finite-query migration | S2a |
| S2g delete old browser finite-query helpers | S2b, S2c, S2d, S2e, S2f |
| S3a Wired server session interface/adapter tests | S1b |
| S3b preview migration | S3a |
| S3c snapshot activity/reply migration | S3a |
| S3d snapshot reference/profile migration | S3a |
| S3e delete old Wired server relay helpers | S3b, S3c, S3d |
| S4a wired-admin session interface/adapter tests | S1c |
| S4b activity/reply migration | S4a |
| S4c reference/profile migration | S4a |
| S4d scheduler/API cancellation + old-helper deletion | S4b, S4c |
| S5 recursive preview completeness | S3b |
| S6a dynamic feed-root hints | S2b |
| S6b context-hint coverage/fix | S2c |
| S7a traversal prototype/go-no-go | S2a, S3a, S4a |
| S7b browser-thread traversal | approved S7a, S2b |
| S7c browser-feed traversal | approved S7a, S2b |
| S7d Wired snapshot traversal | approved S7a, S3c, S3d |
| S7e wired-admin snapshot traversal | approved S7a, S4b, S4c |
| S8 profile in-flight ownership | S2f |
| S9N-design notification cursor/UI contract | S1b |
| S9N-implement notification cursor/history | approved S9N-design, S2d |
| S9P profile >250 chunking | S8 |
| S10a publish deadline/status decision | S1d |
| S10b publish deadline implementation | approved S10a |
| S11-root root batching prototype | S2b, S1d |
| S11-quote quote batching prototype | S2e, S1d |
| S11-bootstrap bootstrap/live handoff prototype | S2b, S1d |
| S12-preview preview duplication investigation | S1d |
| S12-snapshot producer ownership investigation | S1d, S1e |

“Approved” means the blocker closed with a go decision and the explicit contract referenced by the dependent ticket. A no-go or insufficient-evidence close does not unlock production implementation.

## S0 — land the reviewed no-UX-tradeoff audit changes

- **User-visible behavior:** identical thread/feed/notification/quote results; terminal relay failures no longer break or unnecessarily delay covered workflows; concurrent same-event publication completes both callers.
- **Ownership:** existing Wired browser/server and wired-admin workflow owners; no new seam.
- **Controlled relay impact/confidence:** high confidence. Preview disconnect completion 2,506→26 ms with identical 3/3 IDs; notifications 8→6 deliveries with 2/2 displayed IDs; quote hint 6→5 REQ and 4→3 deliveries with 2/2 quote IDs; browser duplicate publish 4→2 EVENT/OK and hang removed; server equivalent-target publish 3→2 connection/EVENT/OK; one late server connection changes orphaned→closed.
- **Coverage/invariants/p95:** no target/filter/accepted-set narrowing. Preserve the after baselines: preview normal p95 31 ms, notifications 39 ms, quotes 23 ms, browser publish 9 ms, server publish 21 ms.
- **Verification:** current PR suites and before/after JSON are the behavioral transcripts; rerun exact fixtures on merge commit.
- **Observability:** existing local summaries only; do not delay landing for S1.
- **Rollout/rollback:** merge draft PRs [Wired #122](https://github.com/smolgrrr/Wired/pull/122) and [wired-admin #79](https://github.com/smolgrrr/wired-admin/pull/79) independently after CI/review. Revert the isolated commit if exact IDs, accepted relays, or guardrails regress.
- **Blocked by:** none. This slice accounts for R-THR-1 lifecycle fix, F-FEED-7, R-NE-1/2, and R-PUB-1/2/3.

## S1 — add a versioned, content-free workflow status contract

- **User-visible behavior:** none; status collection is non-blocking and cannot alter completion.
- **Ownership/seam:** shared field vocabulary from the transcript contract; repo-local adapters in Wired and wired-admin. No cross-repository runtime import.
- **Expected relay reduction/confidence:** no direct reduction. High confidence that the evidence enables safe prioritization; it does not measure relay load.
- **Coverage/invariants/p95:** zero filter, target, result, ACK, retry, or timing change. Instrumentation overhead must be below measurement noise and never await I/O.
- **Fields:** workflow owner, attempt/target count, connection open/close/reuse/late-cleanup, REQ/EVENT and byte counts, unique results, EOSE/terminal/timeout/cancel, duplicates/coalesced operations, accepted-count bucket/rejection, owner retry, first-result and completion duration. No event content, IDs, pubkeys, full relay URLs, or unbounded labels.
- **Operational export seam:** collectors aggregate into fixed buckets in memory, then offer sealed aggregate envelopes to an optional `WorkflowStatusSink`. Export is fire-and-forget through a queue capped at 100 envelopes; overflow/failure increments one local counter and drops oldest data. Relay/query/publish completion never awaits the sink. Wired browser batches use a size/rate-limited same-origin ingest; Wired serverless and wired-admin use repo-local adapters for the same versioned envelope. No production runtime package crosses repositories.
- **Durable collection:** the ingest writes only validated aggregate envelopes to an operator-controlled append-only telemetry store with automatic 14-day TTL deletion. Maximum envelope size, allowed owner/status enums, per-service rate limit, and daily row cap are enforced before storage; overflow is one bounded counter. Access is limited to the named Wired deployment owner and wired-admin operator, with access/deletion documented in the ticket. S1d owns the Wired ingest/export and S1e owns the wired-admin exporter.
- **Cross-instance correlation:** where S12 needs same-key preview pairing, every Wired serverless instance derives the same daily key from a deployment-shared secret and UTC date, computes a 96-bit HMAC token, and never exports the event ID or secret. The deployment secret stays only in managed server configuration and rotates at least quarterly; daily derived keys are not stored. The store applies the S12 1,000-key/day LRU/sample cap and 14-day TTL. Other workflows use fixed aggregate buckets and no correlation token.
- **Transcript tests/measurement:** every outcome bucket, instrumentation disabled/failure path, bounded retention, schema version, and equality of owner terminal state/p95 with instrumentation off/on.
- **Staging:** test invalid/oversized/rate-limited envelopes, queue/store outage, TTL deletion, access scope, browser navigation/offline loss, serverless cross-instance HMAC equality, secret rotation, and fixed-cardinality bounds. Establish ordinary count/duration distributions for at least one deployment window before S10–S12 decisions. Counts remain client-observed outcomes only.
- **Rollout/rollback:** local collection first; ingest/export at 10% then 100%. Disable either adapter or ingest independently and delete its aggregates without changing relay operations. Any sink latency, error, or storage outage only drops evidence.
- **Blocked by:** S0. Implements R-PUB-6 and the measurement prerequisite in R-THR-4, R-FEED-3/4/6, R-NE-5.

## S2 — deepen Wired browser finite-query lifecycle ownership

- **User-visible behavior:** unchanged early event delivery and route cleanup. Finite work reports explicit per-target EOSE/closed/connect-failed/timed-out/cancelled completion; cancellation settles after cleanup.
- **Ownership/seam:** `BrowserRelayAccess` at the existing RelayPool/client seam. Workflow modules retain filters, coverage selection, traversal, caches, and UI state. nostr-tools objects/timers remain internal.
- **Expected relay reduction/confidence:** no frame reduction claimed. High confidence in lifecycle locality; removes recurrence risk for stale timers/sockets and duplicate terminal bookkeeping.
- **Coverage/invariants/p95:** normalized union of workflow-configured plus hinted targets; configured work never waits for hint connection. Preserve browser thread initial/complete p95 28/48 ms, context 19 ms, feed 26/50 ms, notifications 39 ms, profiles 34 ms, and quotes 23 ms.
- **Transcript tests:** no connected target, partial connect, EOSE, close-before-EOSE, connect-after-deadline, no-EOSE, cancel-before/after handle creation, navigation change, delayed hint, exact result identity and CLOSE/timer cleanup.
- **Before/after measurement:** identical filters/targets/REQ/results and equivalent p50/p95 for one workflow at a time.
- **Observability:** S1 query terminal states and late-cleanup count.
- **Rollout/rollback:** expand behind existing functions, migrate root/context/notification/quote/profile finite queries separately, then remove old helpers. Roll back each adapter without reverting the deep module.
- **Blocked by:** S1. Architecture prefactor, not a new relay optimization.

## S3 — extract Wired server finite relay sessions

- **User-visible behavior:** snapshot-first preview and feed output remain identical; every fresh session owns connection deadline, dynamic hints, finite query settlement, cancellation, and final cleanup.
- **Ownership/seam:** repo-local `withFiniteRelaySession` for Wired serverless preview and feed snapshot code, using nostr-tools 2.5.1. Cache/fallback/traversal stay outside.
- **Expected relay reduction/confidence:** healthy REQ/fan-out unchanged; high-confidence late-socket/timer cleanup and bounded terminal completion. Real failure frequency unknown.
- **Coverage/invariants/p95:** identical configured+hinted target union and partial-relay success; preview normal p95 ≤31 ms from the merged S0 baseline and snapshot ≤52 ms. Keep current deadlines during extraction; any changed target requires explicit approval.
- **Transcript tests:** connect-after-deadline, close/error before EOSE, no-EOSE, all fail, cancellation, dynamic hint discovered mid-session, sequential phase reuse, final handles zero, exact preview/snapshot equality.
- **Before/after measurement:** 20-run normal/degraded transcripts for preview and snapshot; no changed filters or output.
- **Observability:** S1 per-phase session states and socket ownership.
- **Rollout/rollback:** preview lifecycle first, snapshot phases second; old functions remain adapters until equivalence, then delete duplicated direct Relay/timer code.
- **Blocked by:** S1. Implements Wired half of R-FEED-1 and the architecture prefactor for R-THR-1/2.

## S4 — extract wired-admin finite relay sessions

- **User-visible behavior:** cached snapshot stays available; a refresh remains atomic and partial-relay tolerant; hung/terminal connections cannot hold every coalesced trigger indefinitely.
- **Ownership/seam:** repo-local `withFiniteRelaySession` inside feed snapshot refresh, against nostr-tools ^2.23.8. Scheduler, `refreshPromise`, carry-forward, persistence, traversal, and profile selection remain outside.
- **Expected relay reduction/confidence:** normal REQ/fan-out unchanged; high confidence in cleanup/bounded completion, medium production occurrence.
- **Coverage/invariants/p95:** same configured and discovered hint union, exact IDs/newest profiles, prior snapshot on failure, complete p95 ≤48 ms and unchanged per-phase deadline.
- **Transcript tests:** same S3 failure matrix plus simultaneous scheduler/manual/API triggers returning one snapshot, cancellation, persistence failure, and dynamic reference hints.
- **Before/after measurement:** exact 8-REQ normal transcript, 3/3 IDs, reference/profile fixture, no-EOSE fixture, socket/timer count.
- **Observability:** S1 refresh phase/result/terminal summaries; no raw content.
- **Rollout/rollback:** migrate activity, replies, references, then profiles without changing filters; revert phase adapter on identity/p95 regression.
- **Blocked by:** S1. Implements wired-admin half of R-FEED-1.

## S5 — restore recursive server-preview reply completeness

- **User-visible behavior:** HTML/social-card previews include immediate-parent-only legacy descendants and accurate reachable reply counts, not only root-tagged descendants.
- **Ownership:** Wired server preview traversal using S3 session; snapshot-first gate unchanged.
- **Expected relay impact/confidence:** may increase REQ/bytes; no reduction claim. High confidence in the measured 2/3→required 3/3 completeness defect.
- **Coverage/invariants/p95:** same configured+hinted targets and partial success. Preserve root/excerpt identity and normal first result; establish an approved complete-preview target from a 20-run recursive fixture rather than silently retaining p95 34 ms if deeper work is required.
- **Transcript tests:** compliant and immediate-parent-only deep/wide replies, duplicates, delayed/no-EOSE/disconnect, hints, cache hit/miss, exact reachable set and reply count.
- **Measurement/observability:** frontier depth/chunks, unique/repeated deliveries, initial/complete duration through S1; never cap silently.
- **Rollout/rollback:** isolated preview traversal flag. Stop on missing root, lower reply count, socket leak, availability loss, or target regression; roll back behavior but retain failing completeness fixture.
- **Blocked by:** S3. Implements R-THR-2.

## S6 — connect dynamic browser hints without delaying configured coverage

- **User-visible behavior:** missing feed roots and required context can resolve from newly discovered NIP-10/NIP-19 hints while configured relays still start immediately.
- **Ownership:** feed-root/context workflow chooses hints, tracks still-missing IDs, and constructs each exact filter. S2 owns only connection, query execution, late arrival, completion, and navigation cleanup.
- **Expected relay impact/confidence:** can add connections/REQ where a hint adds coverage; no savings claim. High confidence in static omission, unknown production frequency.
- **Coverage/invariants/p95:** configured coverage never waits for or is replaced by hints; exact IDs deduped; browser feed initial/complete p95 ≤26/50 ms for equivalent fixtures.
- **Transcript tests:** already connected, new/delayed/failing/normalized-duplicate hint, chained refs, navigation cancellation, configured result before hint, hint-only result.
- **Measurement/observability:** discovered/connected/queried/resolved hint counts and initial/result completion; content-free.
- **Rollout/rollback:** feed-root path flag; disable dynamic connections if p95 or stability regresses while retaining explicit coverage finding.
- **Blocked by:** S2. Implements R-FEED-5 and verifies the THR-B3 hint coverage gap.

## S7 — prototype complete reply/frontier traversal before replacing caps

- **User-visible behavior:** every reply/root/reference reachable through coverage, including depth >2, >50 parents, >100 matches, and immediate-parent-only tags, with live arrivals preserved in browser flows.
- **Ownership:** workflow-local browser thread/feed and repo-local Wired/wired-admin snapshot traversal modules; S5 owns server preview separately. S2–S4 supply transport only.
- **Expected relay impact/confidence:** correctness may add work. High confidence caps are incomplete; medium confidence in any split backfill/live design. No production reduction promised.
- **Coverage/invariants/p95:** never reduce relays, age, depth, parent set, or results. No browser handoff gap. Establish explicit completion targets for large fixtures; existing ordinary thread 28/48 ms and feed 26/50 ms remain regression comparators.
- **Prototype tests:** depth/width/result-limit edges, historical pagination/exhaustion, same-second arrival during replacement, delayed/no-EOSE relay, hints, duplicates, cache/bootstrap overlap, cancellation, bounded peak subscriptions.
- **Measurement:** exact reachable set first; then REQ/bytes/repeats/peak subscriptions/initial and complete timing. Compare alternative frontier/chunk/live handoffs.
- **Observability:** frontier size/depth/chunks, result exhaustion reason, handoff duration.
- **Rollout/rollback:** prototype produces separate implementation tickets per runtime. Feature-flag each; stop on any omitted ID, unbounded live subscription count, or unapproved p95 change.
- **Blocked by:** S2–S4. Implements R-THR-3 and R-FEED-2; subsumes correctness portions of R-NE-4 where pagination semantics overlap.

## S8 — own profile requests through EOSE and deduplicate in-flight pubkeys

- **User-visible behavior:** later consumers join an existing profile request, still receive the newest metadata from every covered relay, and can retry after a completed miss.
- **Ownership:** Wired profile enrichment cache; S2 executes finite query. Positive cache and newest-event selection stay with profile owner.
- **Expected relay reduction/confidence:** controlled staggered duplicate query 2→1 for the same still-missing pubkey; high mechanism confidence, unknown ordinary frequency.
- **Coverage/invariants/p95:** all configured profile relays, newest `created_at`, immediate positive-cache hits, no permanent negative cache, retry after EOSE; profile complete p95 ≤34 ms.
- **Transcript/hook tests:** same-task and staggered consumers, older/newer competing metadata, missing pubkey, partial/terminal relay, unmount, retry after miss, >250 authors handed to S9.
- **Measurement/observability:** pending/in-flight/cache-hit/join/miss-retry counts, exact selected metadata, p95.
- **Rollout/rollback:** cache-owner flag; revert in-flight joining on stale/missing metadata or timing regression.
- **Blocked by:** S2. Implements R-NE-3.

## S9N/S9P — complete notification history and profile chunking independently

- **User-visible behavior:** notification history is explicitly cursorable/exhaustible and profile batches above 250 do not silently omit metadata.
- **Ownership:** S9N belongs to the notification product/history owner; S9P belongs to the profile enrichment owner. Transport only executes exact pages/chunks. They are separate tickets and rollouts.
- **Expected relay impact/confidence:** may add REQ; no efficiency claim. High confidence current caps cannot prove completeness, medium final cursor design.
- **Coverage/invariants/p95:** same authored+mentioned union, no arbitrary `since`, every requested profile/newest event, current first-page notification p95 ≤39 ms and profile p95 ≤34 ms. Older-page completion gets its own target.
- **Tests:** >25 authored, >50 tagged, duplicates across pages, cursor stability/same timestamps, >250 profiles, partial/no-EOSE relays, exact union/newest selection.
- **Measurement/observability:** page/chunk count, exhaustion, unique/duplicate results, first-page and full-history duration.
- **Rollout/rollback:** S9P chunks profiles independently. S9N first produces a cursor/UI contract, then a separate implementation ticket; restore the bounded first page rather than ship a partial cursor.
- **Blocked by:** S9N requires S1; S9P requires S8. Implements R-NE-4.

## S10 — decide, then implement bounded browser publish completion

- **User-visible behavior:** compose cannot remain publishing forever after a healthy acceptance; an accepted post is never labelled unpublished, and exact accepted relays at the chosen completion boundary remain visible.
- **Ownership:** compose UX defines status/late-ACK behavior; browser relay access owns timer/settlement; later explicit retry remains allowed.
- **Expected relay reduction/confidence:** no relay reduction; bounds unlimited wait. High confidence in the silent-relay mechanism, low confidence in a deadline until S1 ordinary evidence exists.
- **Coverage/delivery/p95:** attempt every configured relay, no first-ACK cancellation, preserve at-least-one success and current partial-accept p95 ≤9 ms in controlled healthy fixture. Deadline must not be derived from loopback p95.
- **Tests:** early/late accept, accept exactly at boundary, all reject, all silent, disconnect, same-ID coalescing and post-settlement retry, revenue activation states, owner UI before/after settlement.
- **S10a observation/decision:** observe 7 consecutive deployment days or 100 eligible browser publishes, whichever occurs later, capped at 14 days. Output an approved duration plus exact states for healthy acceptance with silent peers, all silent, all reject, timeout with zero acceptance, and late ACK. If the threshold is not reached by day 14, close with insufficient evidence and do not choose a deadline.
- **S10b implementation:** only after S10a approval, add the timer/settlement behavior behind a flag with the listed transcript matrix.
- **Measurement/observability:** target outcomes, accepted-count bucket, pending duration, late ACK, and candidate deadline exceedance via S1; content-free bounded aggregates only.
- **Rollout/rollback:** S10a status collection ramps 10%→100% and disables on measurable compose p95 overhead or state changes. S10b then stages 10%→100%; disable the deadline without removing evidence if false failure or accepted-relay reporting regresses.
- **Blocked by:** S10a requires S1d; S10b requires S10a's approved contract. Implements R-PUB-4 while preserving R-PUB-5.

## S11 — run optional timing-equivalent batching and handoff experiments

Create separate prototype tickets; none is approved for production from audit evidence alone.

| Experiment | Controlled opportunity | Required invariant/target | Ship gate |
| --- | --- | --- | --- |
| Same-microtask root batching (R-FEED-6) | 21 roots produced 42 reply REQ over two relays; two 20+1 chunks could produce 4 when roots arrive together. | Exact descendants; never wait for EOSE/debounce; feed first/complete p95 ≤26/50 ms. | Lower REQ in synchronous bursts with equivalent timing across staggered arrivals. |
| Quote fallback batching (R-NE-5) | Three refs over two fallbacks could change 6→2 fallback REQ. | Kind 1/1068 identity, per-ref missing state, hints independent, quote p95 ≤23 ms. | Equivalent first-quote and completion timing in one/many/mixed-hint fixtures. |
| Bootstrap/live ownership handoff (R-FEED-3) | Controlled overlap produced 8 versus 4 REQ for the same root traversal. | Bootstrap first paint and authoritative live completeness; no delivery gap; p95 ≤26/50 ms. | S1 shows ordinary overlap and a tested handoff removes only duplicate work. |

- **Ownership:** each workflow owner; S2 supplies lifecycle but does not choose batching.
- **Observability:** operation signature, owner path, first-result/completion, exact IDs, REQ/bytes; no raw event data.
- **Rollout/rollback:** prototype first, one flag per experiment, immediate rollback on identity/timing regression.
- **Blocked by:** use the per-experiment S11 edges in the authoritative matrix. Low priority because ordinary savings are unknown and UX timing risk is higher than S0/S8.

## S12 — bounded deployment investigations before shared caches/producers

Create one investigation ticket per row. Each runs for 7 consecutive deployment days or 100 eligible operations, whichever occurs later, capped at 14 days. If the threshold is not reached by day 14, close with “insufficient ordinary evidence; keep current ownership.” No investigation implements consolidation.

| Investigation | Operational owner | Collection surface and control | Rollout / stop condition | Exit decision |
| --- | --- | --- | --- | --- |
| Preview endpoint coalescing (R-THR-4): do HTML and card endpoints perform same-key fallback inside a safe freshness window? | Wired preview deployment owner. | S1d ingest uses `HMAC-SHA256(derivedDailyDeploymentKey, eventId)` truncated to 96 bits plus endpoint class, so separate instances correlate without receiving raw IDs. Derived keys are never stored; the managed deployment secret rotates at least quarterly. Hashes expire in a store-side LRU capped at 1,000 sampled keys/day and 14 days, with one overflow counter and no per-overflow label. Sample before admitting a new key when the cap is reached. Persist no event/content/relay URL or key. Before enablement, transcript tests prove measurement off/on preserves exact preview and p95 ≤31 ms. Collect snapshot hit/miss/fallback pairing, ordering, reply-count change, and p50/p95. | Enable 10% for one day, then 100%. Disable and delete the run on any preview-state difference, >measurement-noise p95 regression, unbounded labels, or collection failure affecting requests. | Keep independent; or open a new ticket for in-process coalescing/narrow freshness cache with a measured duplicate rate and safe key/window. |
| Snapshot producer ownership (R-FEED-4): are Wired cron/serverless and wired-admin refresh both deployed, consumed, and overlapping? | Joint Wired bootstrap deployment owner and wired-admin refresh operator; one named driver in the ticket. | S1 aggregate trigger/cadence/config fingerprint and snapshot identity/count summary, plus a written consumer map; retain ≤14 days. Controlled equivalent-snapshot and instrumentation-off/on tests preserve Wired p95 ≤52 ms and admin ≤48 ms. No raw events or relay URLs. | Enable each producer independently at 10%, then 100%. Stop on cache availability/result difference, p95 regression, label growth, or any measurement dependency affecting refresh. | Keep both for isolation; or open a new dual-read/expand-before-migrate owner ticket with demonstrated overlap, consumer/failover plan, and retained rollback cache. |

- **Expected relay reduction/confidence:** unknown until observed; metric is eliminated duplicate refresh/fallback connections/REQ, not guessed load.
- **Coverage/invariants:** same cache availability, relay coverage, output, metadata freshness, independent failure recovery, and applicable p95.
- **Transcript tests:** instrumentation disabled/enabled/failing, correlation expiry, retention bound, identical outputs, and no change to trigger/coalescing behavior.
- **Rollback:** disable S1 collection only. Any later cache/owner migration is a new ticket with dual-read comparison, staged consumer switch, and retained old cache.
- **Blocked by:** S12-preview requires S1d; S12-snapshot requires S1d and S1e. S3/S4 improve later implementation options but are not required for observation.

## Recommendation mapping

| Audit recommendation | Plan slice |
| --- | --- |
| R-THR-1 terminal/late preview ownership | S0 implemented evidence; S3 durable session ownership |
| R-THR-2 recursive preview | S5 |
| R-THR-3 complete browser traversal | S7 |
| R-THR-4 preview coalescing measurement | S1 + S12 |
| R-FEED-1 finite server lifecycle | S3 + S4 |
| R-FEED-2 complete chunked traversal | S7 |
| R-FEED-3 bootstrap/live measurement | S1 + S11 |
| R-FEED-4 snapshot ownership evidence | S1 + S12 |
| R-FEED-5 dynamic hints | S2 + S6 |
| R-FEED-6 zero-delay root batching | S11 |
| R-NE-1 remove discarded kind 7 | S0 implemented |
| R-NE-2 query quote hint once | S0 implemented |
| R-NE-3 in-flight profile ownership | S2 + S8 |
| R-NE-4 notification/profile completeness | S7 + S9N/S9P |
| R-NE-5 quote batching prototype | S11 |
| R-PUB-1 same-ID coalescing | S0 implemented |
| R-PUB-2 normalized target dedup | S0 implemented |
| R-PUB-3 late connection cleanup | S0 implemented |
| R-PUB-4 browser deadline contract | S1 + S10 |
| R-PUB-5 owner-specific retries | Preserved explicitly in S0/S10; no generic optimization ticket |
| R-PUB-6 status evidence | S1 |

## Production workflow coverage

| Workflow IDs | Accounted for by |
| --- | --- |
| THR-B1/B3 | S0, S2, S6; S7 if context traversal changes |
| THR-B2 | S2 compatibility path, then S7 |
| THR-S1/S2 | S0, S3, S5, S12 |
| FED-B0–B4 | S0, S1, S2, S6, S7, S11 |
| FED-W0–W5 | S1, S3, S7, S12 |
| FED-A0–A5 | S0, S1, S4, S7, S12 |
| NOT-1/2 | S0, S1, S2, S9N |
| ENR-1 | S1, S2, S8, S9P |
| ENR-2 | S2/S6 and S7 only if traversal ownership changes |
| ENR-3–5 | S0, S1, S2, S11 |
| PUB-1 | S0, S1, S10 |
| PUB-2/3/5 | S0/S1; owner-specific behavior remains unchanged |
| PUB-4 | S0/S1; persisted revenue retry remains owner-local |
| PUB-6 | S0 gateway transcripts and S1 status vocabulary; protocol adapter remains separate |

## Work that must not proceed yet

- No cross-repository runtime package while the module interfaces and nostr-tools versions differ.
- No single snapshot producer, endpoint cache, or cross-process lock before S12 evidence.
- No bootstrap/live cancellation, root batching, or quote batching before S11 timing equivalence.
- No arbitrary browser publish timeout before S1 and an approved status contract.
- No smaller relay sets, age windows, depth/parent/result limits, notification/profile caps, first-relay completion, first-ACK cancellation, permanent negative cache, or snapshot-only authority.
- No global filter/event-ID dedup across owner-defined retry or freshness windows.

## `/to-tickets` handoff contract

When this plan is ticketed:

- Follow the **Required agent-sized ticket decomposition** exactly. Numbered slices are planning groups; never emit one ticket for all of S1, S2, S3, S4, S7, S9, or S10.
- Create one ticket per S11/S12 experiment. S7a/S9N-design/S10a/S12 tickets end with measured decisions and create separately blocked production tickets only on a go decision.
- Encode only the **Authoritative ticket-level blocker matrix**. The group dependency table is explanatory; do not create umbrella issues or serialize S2, S3, and S4 against one another.
- Copy the slice's behavior, owner, relay impact/confidence, invariants/p95, transcript/measurement, observability, rollout, and rollback into acceptance criteria.
- Link the detailed audit recommendation and architecture section rather than copying raw evidence.
- Label correctness slices separately from relay-reduction slices so added work is not misreported as inefficiency.
- Close investigation/prototype tickets with a measured go/no-go decision; they do not automatically authorize production implementation.

## Final priority

S0 is immediately mergeable high-confidence work. S1–S4 are the safe foundation. S5–S10 address demonstrated completeness, duplication, and completion defects in that order, with correctness allowed to add work. S11–S12 remain bounded experiments because their real frequency or timing equivalence is unknown. No plan item purchases lower relay work by sacrificing replies, metadata, delivery, or timely UX.
