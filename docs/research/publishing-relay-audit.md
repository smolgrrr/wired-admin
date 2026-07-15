# Publishing relay audit

Issue: [#76](https://github.com/smolgrrr/wired-admin/issues/76)

Audited branches: Wired `codex/relay-efficiency-improvements`; wired-admin `codex/relay-efficiency-audit`

Evidence: [`publishing-before-local-2026-07-15`](relay-audit-data/publishing-before-local-2026-07-15.json) and [`publishing-after-local-2026-07-15`](relay-audit-data/publishing-after-local-2026-07-15.json).

## Outcome

Six publishing operations cover all Nostr `EVENT` traffic in the two repositories: direct browser posts, Wired-account posts, confessions, zap receipts, the optional revenue profile, and client events proxied by the relay gateway. The browser uses already-pooled configured connections. All server-originated events share `publishNostrEvent`, which opens one connection per normalized target, waits for each relay to accept/reject/fail or time out, reports the exact accepted relay set, and closes every obtained connection. Server workflows declare success only when at least one relay accepts. The gateway forwards an accepted or rejected backend `OK` unchanged and rejects insufficient PoW locally without forwarding the event.

Three clear no-UX-tradeoff defects are fixed on the audit branches. Concurrent browser calls for the same event ID previously sent the event twice per relay and caused one caller to remain pending because nostr-tools tracks a publish resolver by event ID; calls are now coalesced until settlement. Server publication previously contacted equivalent targets such as `wss://relay` and `wss://relay/` twice; normalized targets are now unique within an invocation. A server relay that completed connection after the connection deadline was previously orphaned; the late connection is now closed without publishing.

The remaining material UX defect is the browser's lack of a publication deadline: one silent connected relay keeps the entire publish and compose completion pending even after another relay accepts. A deadline would improve timely completion but changes how late acknowledgements are reported, so this audit records the required contract rather than selecting an arbitrary production duration. No relay coverage, acceptance threshold, retry opportunity, or user-visible result was reduced.

No controlled scenario contacted a public relay. Counts and timings below describe loopback fixtures, not real relay traffic, load, acceptance rates, or latency.

## Operation inventory

| ID | Owner and trigger | Targets / connection lifecycle | Completion, ACK, retry, and user contract |
| --- | --- | --- | --- |
| PUB-1 | Wired `useSubmitForm`: a browser-signed kind-1 post after PoW. | `RelayPool.publish` uses the initialized default relay set and existing pooled connections. One `EVENT` per connected target. Concurrent calls for the same event ID now share one in-flight operation; a later retry after settlement is allowed. | Resolves with the exact set of accepting URLs after every target settles. Zero accepts displays “draft was not posted”; one or more displays published and the exact relays. Enrollment activation occurs after publication and has a distinct published-but-activation-failed state. A silent relay currently leaves completion pending. |
| PUB-2 | wired-admin Wired-account HTTP workflow: re-signs an admitted post. | `publishNostrEvent(event, wiredAccountRelays, timeout)`. Fresh normalized unique connection per relay; connect and publish each have a configured deadline; every obtained or late connection closes. | At least one accept commits the post record and returns its exact accepted relay list. Zero accepts returns 502 and fails pending revenue enrollment. The proof/store lock prevents reuse; no automatic publish retry. |
| PUB-3 | wired-admin confession HTTP workflow: creates a server-signed confession. | Same bounded fresh-connection publisher over `confessRelays`. | At least one accept commits the confession ledger record. Zero accepts returns 502. The serialized ledger and used-proof check prevent duplicate admitted submissions; no automatic relay retry. |
| PUB-4 | Revenue receipt: settlement reconciliation creates/publishes kind 9735. | Same bounded publisher over Wired-account relays. | Receipt becomes `receiptPublished` only after at least one accept. Zero accepts leaves it unpublished; `reconcileAll` retries it later. The persisted receipt/event ID is reused. Repeated invocations may intentionally republish after an ambiguous/failed attempt, so cross-invocation coalescing is not applied at the generic server publisher. |
| PUB-5 | Optional startup revenue kind-0 profile publication. | Same bounded publisher over Wired-account relays when `REVENUE_PUBLISH_PROFILE` is enabled. | Startup operation succeeds with at least one accept and throws on zero. A new startup intentionally republishes replaceable metadata; no hidden retry loop. |
| PUB-6 | Relay gateway: every valid client `EVENT`. | One backend WebSocket per client connection. Messages queue while the backend connects, then forward once; backend connection closes with the client. Invalid/insufficient-PoW events never forward. | Backend `OK` acceptance/rejection is forwarded unchanged and updates status counters. Local PoW rejection sends `OK false`. Backend error sends `NOTICE`; backend close closes the client with 1011. The client owns retry policy. |

## Controlled evidence

| Scenario | Required result | Relay work and connection evidence | Completion |
| --- | --- | --- | --- |
| Browser partial acceptance, 20 runs | Exact 2/3 accepted relay set every run | 3 EVENT, 2 accepted OK, 1 rejected OK, fan-out 3; zero new workflow connections because the pool was preconnected | before p50/p95 8/9 ms; after 7/9 ms |
| Browser full rejection + disconnect | Empty accepted set | 2 EVENT, 1 rejected OK, peer disconnect | deterministic completion |
| Browser silent peer | Preserve healthy relay acceptance | 2 EVENT, 1 accepted OK; still pending after 50 ms, completes only when silent peer disconnects | proves unbounded completion |
| Browser concurrent same-ID call | Both callers receive the exact 2-relay accepted set | before: 4 EVENT/4 OK and one caller pending; after: 2 EVENT/2 OK, pooled fan-out unchanged | completion hang removed |
| Server partial acceptance, 20 runs | Exact 2/3 accepted relay list every run | 3 connections, 3 EVENT, 2 accepted OK, 1 rejected OK, all 3 close | before p50/p95 14/23 ms; after 13/21 ms |
| Server silent + disconnect | Preserve healthy relay acceptance | 3 EVENT, 1 accepted OK, one disconnect, one deadline; all 3 connections close | at least configured 50 ms |
| Server duplicate normalized target plus concurrent invocation | Both invocations receive the same accepted URL | before: 3 connections/EVENT/OK; after: 2. The equivalent URL within the first invocation is removed; the separate invocation remains an intentional operation. | deterministic completion |
| Late server connection | Empty accepted list and no EVENT | before: late connection was not closed; after: exactly one late close | deadline result unchanged |
| Gateway accepted EVENT | Exact backend `OK true` reaches client | 1 backend connection, 1 EVENT, 1 accepted OK, fan-out 1 | deterministic loopback |
| Gateway insufficient PoW | Exact event ID with `OK false`; zero backend EVENT | local rejection counter increments; backend publish count remains zero | deterministic loopback |
| Browser owner boundary | While the publish promise is unsettled, no signed post is exposed and compose status remains `publishing`; after a scheduled 25 ms acceptance, status is `published`, the signed event is exposed, and the exact accepted URL is shown | Actual `useSubmitForm` state transition with a deferred publisher; relay protocol counts are measured separately by the browser transcript | visible completion occurs only after relay settlement; measured duration is at least the scheduled 25 ms |
| Server owner boundaries | PUB-2/3 reject zero accepted relays before committing; PUB-4 marks `receiptPublished` only after acceptance and retries persisted misses; PUB-5 throws on zero acceptance | Production owner branches plus revenue service/ledger contract tests; generic publisher transcript supplies ACK, connection, and p95 evidence | terminal state is correlated by accepted-list contract; endpoint latency is not separately instrumented |

Published fixture frames were 378 bytes in the browser case, 370 bytes in the server-publisher case, and 395 bytes in the gateway case. These byte counts are protocol evidence for the fixed fixtures only.

## Findings and recommendations

### F-PUB-1 — concurrent same-event browser publishing could hang a caller (fixed)

nostr-tools keys its active publication promise by event ID. Two overlapping `RelayPool.publish` calls for the same signed event emitted duplicate `EVENT`s and overwrote one resolver. The before transcript observed four events/four acknowledgements over two relays while `Promise.all` remained pending after 50 ms. RelayPool now owns a per-event in-flight promise through settlement, gives both callers the same accepted set, emits two events total, and clears ownership so explicit later retries remain possible.

### F-PUB-2 — equivalent server relay URLs caused duplicate work (fixed)

The generic server publisher normalized accepted results only after connecting and publishing. A target list containing trailing-slash variants therefore created and used two connections to the same relay. It now normalizes and deduplicates before fan-out. This preserves target identity, accepted reporting, separate invocation semantics, deadlines, and retries.

### F-PUB-3 — a connection resolving after timeout was orphaned (fixed)

Timing out `Relay.connect` discarded its eventual connection object, so it could not be closed. The publisher now attaches cleanup to the pending connection on deadline. The controlled late connector publishes zero events and closes once, with the same empty accepted result and completion deadline.

### F-PUB-4 — a silent browser relay can block user completion indefinitely

PUB-1 waits for all pooled relay publish promises without an application deadline. The controlled workflow had a healthy acceptance at 5 ms but remained pending beyond 50 ms until the silent peer disconnected. This directly violates timely compose completion. Implement a per-relay settlement deadline only after defining: the duration from status evidence, whether accepted relays are surfaced immediately or at aggregate settlement, and how a late acceptance updates status. Preserve at least-one-accept success and never label an already accepted post as unpublished.

### F-PUB-5 — server retries are intentionally owner-specific

Confession and Wired-account HTTP operations do not retry publication automatically. Revenue receipts persist an unpublished state and retry during reconciliation; profile publication can repeat on startup. Cross-invocation coalescing in `publishNostrEvent` could suppress an intentional reconciliation or replaceable-profile attempt, so only within-invocation target deduplication is recommended.

### F-PUB-6 — status evidence exists but is incomplete across publishing owners

The gateway records attempts, accepted/rejected outcomes, backend errors, active clients, and recent events. Server HTTP responses and ledgers retain accepted relay lists, while the browser keeps accepted relays in UI state. There is no shared counter for per-owner timeout/disconnect/full-rejection outcomes or completion percentiles. Add lightweight owner-labelled local telemetry for attempts, fan-out, accepted-count buckets, timeout/disconnect/rejection, duplicate-coalesced count, and completion duration. Do not infer relay load from client counters.

## Decision

Ship F-PUB-1 through F-PUB-3: each removes duplicate/orphaned relay work or a completion hang with unchanged accepted results and relay coverage. Keep F-PUB-4 as the highest-priority publishing follow-up because it improves UX, but require an explicit deadline/status contract and controlled late-ACK test before implementation. Keep retries with their domain owners. Add status evidence without claiming public-relay load.

## Recommendation records

### R-PUB-1 — coalesce concurrent browser publication by event ID (implemented)

1. **Identity/owner:** PUB-1; Wired `RelayPool`.
2. **Evidence:** F-PUB-1 and the before/after concurrent same-ID transcript.
3. **Change:** share one in-flight promise for the same event ID and clear ownership after settlement.
4. **Expected reduction:** controlled duplicate call 4→2 EVENT and 4→2 OK; production frequency is unknown.
5. **Confidence:** high for protocol identity and hang mechanism.
6. **Delivery/UX invariant:** both callers receive the exact accepted relay set; pooled fan-out stays two; a later explicit retry emits a fresh round; compose completion is no slower.
7. **Rejected alternatives:** suppressing all later same-ID calls would remove intentional retries; changing nostr-tools internals would broaden ownership; first-ACK completion would change accepted-relay reporting.
8. **Verification:** concurrent callers, accepted set, EVENT/OK count, post-settlement retry, full rejection, silent/disconnect, and `useSubmitForm` terminal states.
9. **Rollout/staging:** ship as an isolated client-pool change; observe coalesced-call count and compose completion once R-PUB-6 exists.
10. **Rollback:** remove the in-flight map; retain the transcript to expose the restored hang before release.

### R-PUB-2 — deduplicate normalized server targets per invocation (implemented)

1. **Identity/owner:** PUB-2 through PUB-5; wired-admin `publishNostrEvent`.
2. **Evidence:** F-PUB-2 and the equivalent trailing-slash target transcript.
3. **Change:** normalize and unique relay URLs before connecting.
4. **Expected reduction:** controlled mixed invocation 3→2 connections/EVENT/OK; savings occur only when configured targets normalize identically and their production frequency is unknown.
5. **Confidence:** high.
6. **Delivery/UX invariant:** same normalized accepted URLs, deadline, relay identity, separate invocation behavior, and at-least-one success threshold.
7. **Rejected alternatives:** global cross-invocation coalescing can suppress revenue reconciliation or profile republishing; dropping distinct relays reduces delivery coverage.
8. **Verification:** slash variants, concurrent separate call, partial/full rejection, timeout/disconnect, exact accepted list, all connections closed.
9. **Rollout/staging:** isolated generic-publisher change; compare target-count and normalized-target-count status evidence.
10. **Rollback:** publish the original target list if normalization is found to merge semantically distinct endpoints.

### R-PUB-3 — close server connections that resolve after their deadline (implemented)

1. **Identity/owner:** PUB-2 through PUB-5; wired-admin `publishNostrEvent` connection owner.
2. **Evidence:** F-PUB-3 controlled delayed connector.
3. **Change:** retain the pending connect promise and close its relay if it resolves after the caller has timed out.
4. **Expected reduction:** controlled orphaned late connections 1→0; real timeout/connect completion frequency is unknown.
5. **Confidence:** high in ownership, unknown production occurrence.
6. **Delivery/UX invariant:** the caller still completes at its configured deadline with the same empty result; no late EVENT is sent.
7. **Rejected alternatives:** waiting beyond the deadline delays HTTP completion; ignoring the late object leaks a connection; cancelling `Relay.connect` is not supported by this API.
8. **Verification:** delayed successful connection, rejected connection, publish timeout, close throwing, no EVENT, exactly one late close.
9. **Rollout/staging:** count late-connect cleanup without logging event content or inferring relay load.
10. **Rollback:** remove the late cleanup only if the relay library gains a proven cancellable connect contract.

### R-PUB-4 — define and then bound silent browser publication

1. **Identity/owner:** PUB-1; Wired compose and RelayPool owners.
2. **Evidence:** F-PUB-4: healthy acceptance at 5 ms, still pending after 50 ms until silent-peer disconnect.
3. **Change:** define a per-relay settlement deadline and late-ACK status contract before implementation.
4. **Expected reduction:** bounds an otherwise unlimited user wait; no relay-work reduction is claimed.
5. **Confidence:** high in the unbounded mechanism, low in any deadline value without status evidence.
6. **Delivery/UX invariant:** never call an accepted post unpublished; retain every relay attempt and exact acknowledgements received by the completion boundary; do not delay healthy acceptance visibility.
7. **Rejected alternatives:** arbitrary timeout values may hide late accepts; first-ACK cancellation loses fan-out outcomes; removing silent relays reduces coverage; indefinite waiting violates timely UX.
8. **Verification:** early/late accept, all reject, all silent, disconnect, acknowledgement exactly at boundary, compose state and accepted URL updates, p50/p95 in controlled and staging evidence.
9. **Rollout/staging:** first add R-PUB-6 measurements, choose a documented bound, stage behind a setting, and compare completion/result buckets.
10. **Rollback:** disable the application deadline while keeping timeout evidence and status instrumentation.

### R-PUB-5 — preserve retry ownership at workflow boundaries

1. **Identity/owner:** PUB-2/3 HTTP owners, PUB-4 revenue reconciliation, PUB-5 startup profile.
2. **Evidence:** F-PUB-5 and persisted `receiptPublished` state.
3. **Change:** no generic cross-invocation coalescing; keep retries explicit and domain-owned.
4. **Expected reduction:** none claimed; this prevents a work-reduction optimization from breaking delivery.
5. **Confidence:** high for receipt retry semantics.
6. **Delivery/UX invariant:** failed receipts remain retryable, confessions/posts do not duplicate automatically, startup metadata can be replaced.
7. **Rejected alternatives:** global same-ID suppression can drop legitimate reconciliation; automatic generic retries can duplicate posts and delay responses.
8. **Verification:** rejection→explicit retry→accept transcript, receipt unpublished→reconcile→published contract, duplicate proof/store guards.
9. **Rollout/staging:** retain owner-labelled retry counters and operation IDs without event content.
10. **Rollback:** not applicable; any future retry consolidation requires a separate idempotency design.

### R-PUB-6 — add lightweight owner-labelled publishing status evidence

1. **Identity/owner:** PUB-1 through PUB-6; browser/client observability and wired-admin operator status owners.
2. **Evidence:** F-PUB-6 and the current split between gateway counters, response accepted lists, ledgers, and UI state.
3. **Change:** record attempts, target count, accepted-count bucket, timeout/disconnect/rejection, coalesced duplicate, retry, late cleanup, and completion duration by owner.
4. **Expected reduction:** none directly; enables evidence-based deadline and prioritization decisions.
5. **Confidence:** high that the fields describe client-observed outcomes; they do not measure relay load.
6. **Delivery/UX invariant:** telemetry is non-blocking, content-free, bounded, and never changes publication completion.
7. **Rejected alternatives:** raw event/content logging is unnecessary; treating client attempts as real relay load is invalid; per-relay high-cardinality labels create operational waste.
8. **Verification:** unit-test each outcome bucket, dropped/failed telemetry, bounded storage, and unchanged owner terminal states/p95.
9. **Rollout/staging:** expose local aggregate status first; establish a baseline before selecting R-PUB-4's deadline.
10. **Rollback:** disable aggregation independently of publishing; retain deterministic transcript tests.

## Explicitly rejected breadth reductions

- Do not remove configured relays, stop after the first acceptance, or lower fan-out: each changes delivery/ACK visibility.
- Do not globally suppress repeated event IDs: revenue reconciliation and replaceable metadata can intentionally republish.
- Do not shorten existing server deadlines or invent a browser deadline from loopback p95 values.
- Do not interpret EVENT/REQ counts from these clients as public-relay load or capacity.
