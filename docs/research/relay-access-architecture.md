# Relay-access architecture recommendation

Issue: [#77](https://github.com/smolgrrr/wired-admin/issues/77)

Inputs: [thread/preview audit](thread-preview-relay-audit.md), [feed/refresh audit](feed-refresh-relay-audit.md), [notification/enrichment audit](notification-enrichment-relay-audit.md), and [publishing audit](publishing-relay-audit.md).

## Decision

Keep production relay access repository-local and runtime-specific. Deepen two existing seams rather than create one cross-repository relay package:

1. In Wired browser code, deepen the existing pooled `RelayPool` into the sole owner of browser connections, finite-query terminal state, late hinted connections, subscription cleanup, and same-event publication coalescing. Workflow modules continue to own filters, traversal, caches, and UX state.
2. In each server runtime, introduce a repo-local finite relay session module that owns fresh connection attempts, deadlines, late arrivals, sequential finite queries, terminal EOSE/close/error settlement, and final socket cleanup. Feed/preview workflow modules continue to own relay selection, traversal, newest-metadata rules, cache writes, and output.
3. Keep server publication as a separate deep module because its interface is acknowledgements and owner-specific retries, not query completion. Do not force reads and writes through one shallow transport wrapper.
4. Standardize the measurement contract and terminology, not the runtime implementation. Each repository retains its own test adapter and emits the same bounded workflow summary fields.
5. Keep caching, deduplication, batching, pagination, and retries with the workflow that can state their correctness and freshness contract. Promote only proven lifecycle mechanics into shared repo-local modules.

This is the smallest architecture justified by evidence. It concentrates lifecycle complexity behind small interfaces while avoiding a new deployment/package dependency between codebases that currently use materially different nostr-tools versions: Wired `2.5.1` and wired-admin `^2.23.8`.

## Why the runtimes remain distinct

| Runtime | Connection model | Result/completion contract | State and retry owner | Architectural consequence |
| --- | --- | --- | --- | --- |
| Wired browser reads | Long-lived pooled configured connections plus event-specific hints; route cleanup matters. | Stream events promptly; finite work completes after every covered relay is EOSE/terminal/deadline; thread replies also remain live. | Route/workflow owns visible state; pool owns transport lifecycle. | Deepen the existing browser pool; do not replace it with per-query fresh sockets. |
| Wired serverless reads | Fresh sockets per preview/snapshot invocation; process reuse is optional. | Return one complete snapshot/preview or partial-relay result by the existing deadline, then close everything. | Request/cache owner decides fallback and persistence. | A scoped finite session is safer than permanent pooling or a cross-instance lock. |
| wired-admin long-running reads | Fresh scoped sockets per refresh; in-process overlapping triggers already share `refreshPromise`. | Produce/persist an atomic snapshot; retain previous snapshot on failure. | Feed snapshot module owns scheduler, carry-forward, cache, and refresh retry. | A finite session can be reused across phases, but connection lifetime must not escape a refresh. |
| Browser publication | Existing pooled connections; exact accepted relay set is user-visible. | Resolve after target settlement; at least one acceptance means published. Same-ID overlapping calls coalesce, later calls retry. | Compose owner controls UI/enrollment state. | Publication remains on browser relay-access module, with a separately designed status deadline. |
| Server publication | Fresh connection per normalized relay target; bounded connect/publish; close after attempt. | Exact accepted list; at least one acceptance commits owner state. | HTTP owners do not auto-retry; revenue reconciliation intentionally retries; profile may republish on startup. | Keep `publishNostrEvent` separate from query sessions and do not coalesce across invocations. |
| Relay gateway | One backend connection per client connection; client protocol is passed through. | Backend `OK` or local `OK false`; client owns retry. | Gateway counters and client. | Keep as a protocol adapter, not a feed/query module. |

## Shared constraints from all workflows

- **Relay coverage:** preserve the normalized union of configured relays and applicable event hints. A connection failure may yield partial results; an optimization may not silently omit a target.
- **Reachable completeness:** every reachable reply and required context/profile event within relay coverage remains required. Existing depth, parent, result, notification, and profile caps are correctness gaps, not efficiency tools.
- **Timeliness:** stream useful results as they arrive. Do not wait for EOSE merely to batch, and do not cancel live/bootstrap fallback until an explicit handoff proves equivalent timing.
- **Finite completion:** EOSE, terminal close/error, connect failure, and the unchanged application deadline are terminal states. Every late connection/subscription remains owned and is closed.
- **Hints:** configured coverage starts immediately. New hints may connect in parallel and query still-missing exact IDs; they never replace configured relays or delay them.
- **Caching:** positive caches and snapshots accelerate first paint but do not suppress authoritative live coverage unless freshness/completeness is explicit. Newest replaceable metadata wins.
- **Deduplication:** normalize relay URLs and deduplicate IDs/operations inside the narrowest proven ownership window. Do not globally suppress later retries or refreshes.
- **Publishing:** report exact acknowledgements received by completion, preserve at-least-one success, and keep retry semantics with the domain owner.
- **Measurement:** count client-observed connections, REQ/EVENT frames, bytes, EOSE/close/timeout, fan-out, duplicates, accepted/rejected results, and owner completion. Never label these counts as real relay load.

## Proposed deep modules and interfaces

The types below are architectural interfaces, not final TypeScript. Names may adapt to repository conventions, but their ownership must not leak.

### 1. Wired browser relay access

Seam: existing `src/nostr/relay-pool.ts` and `client.ts` entry points.

```ts
type FiniteQuery = {
  filters: Filter[];
  coverage: {
    configuredRelayUrls: readonly string[];
    hintedRelayUrls?: readonly string[];
  };
  completionDeadlineMs: number;
  onEvent(event: Event, relayUrl: string): void;
};

type RelayCompletion = {
  relayUrl: string;
  state: "eose" | "closed" | "connect-failed" | "timed-out" | "cancelled";
};

type RelayConnectionOutcome = {
  relayUrl: string;
  state: "connected" | "connect-failed" | "timed-out" | "cancelled";
};

type QueryCompletion = {
  reason: "settled" | "deadline" | "cancelled";
  targets: readonly RelayCompletion[];
  receivedEvents: number;
};

type QueryHandle = {
  done: Promise<QueryCompletion>;
  close(): void;
};

interface BrowserRelayAccess {
  connectConfigured(urls: readonly string[]): Promise<void>;
  startFiniteQuery(query: FiniteQuery): QueryHandle;
  publish(event: Event): Promise<ReadonlySet<string>>;
}
```

The module normalizes and unions `configuredRelayUrls` plus `hintedRelayUrls`; neither list replaces the other, and it attempts each distinct target once. The workflow/configuration owner supplies `completionDeadlineMs` from the existing workflow deadline during extraction; the module owns and clears the timer. It hides nostr-tools `Relay`/`Subscription`, per-relay EOSE bookkeeping, terminal relay removal, late hint ownership, and application timers. `QueryCompletion` exposes one terminal state for every selected target and no raw transport objects. `QueryHandle.close()` is idempotent: it closes subscriptions and late work, clears timers, and settles `done` with `reason: "cancelled"` only after cleanup; if `done` already settled, close performs no second settlement. Existing live-thread replacement can temporarily retain an internal live-subscription path until the traversal prototype defines its handoff; it should not be generalized prematurely.

Deletion test: removing this module would re-spread connection maps, terminal settlement, timeouts, hint connection ownership, subscription cleanup, and publish coalescing across every workflow, so the seam earns its depth.

### 2. Repo-local finite server relay session

Seams: Wired server `lib` preview/snapshot relay helpers and wired-admin `feed-snapshot-service.ts` direct relay helpers. Implement independently against each repository's installed nostr-tools version.

```ts
type RelaySessionOptions = {
  relayUrls: readonly string[];
  connectDeadlineMs: number;
};

interface FiniteRelaySession {
  ensureRelays(
    relayUrls: readonly string[],
    connectDeadlineMs: number,
  ): Promise<readonly RelayConnectionOutcome[]>;
  query(input: {
    filters: Filter[];
    relayUrls?: readonly string[];
    deadlineMs: number;
    signal?: AbortSignal;
    onEvent(event: Event, relayUrl: string): void;
  }): Promise<QueryCompletion>;
}

async function withFiniteRelaySession<T>(
  options: RelaySessionOptions,
  run: (session: FiniteRelaySession) => Promise<T>,
): Promise<T>;
```

`withFiniteRelaySession` owns normalization, connect deadline, late-connect cleanup, connection reuse inside one workflow, per-query terminal settlement, timers, and final close. `query` returns the same `QueryCompletion` contract as the browser: one state for every selected query target and `settled`, `deadline`, or `cancelled` only after subscriptions/timers are cleaned. Without `relayUrls`, it snapshots every target currently owned by the session; with `relayUrls`, it targets that normalized subset and reports known connection failures explicitly. When `signal` aborts, the session stops accepting events for that query, closes its subscriptions, clears its timer, and only then resolves with `reason: "cancelled"`; the surrounding session remains usable until its callback exits. An already-settled query ignores later aborts.

The initial session target set comes from `RelaySessionOptions`. When earlier results reveal hints, the workflow retains relay-selection policy but passes those URLs to `ensureRelays`. The session deduplicates them, owns their connection deadline and late arrival, and makes successful connections available to later exact-ID queries. Configured queries start immediately; a workflow may connect hints in parallel and query only still-missing IDs after `ensureRelays`, so hints never delay configured coverage. The workflow supplies each existing phase deadline, while the module owns its timer. The callback owns filters and result semantics.

The nostr-tools connector is an internal seam, not part of the workflow interface. The production adapter uses the repository's installed nostr-tools version; the controlled-test adapter supplies delayed, failed, terminal, and no-EOSE relay behavior. Both adapters are exercised through `withFiniteRelaySession`/`FiniteRelaySession`, so tests do not reach past the external seam.

Deletion test: removing this server module would reintroduce URL normalization, connection deadlines, dynamic-hint connection, late-arrival cleanup, per-relay EOSE/terminal counting, query timers, connection reuse, and final socket cleanup in preview and every snapshot phase. Concentrating those mechanics therefore provides leverage and locality rather than pass-through indirection.

Do not expose `Relay[]`, `Subscription[]`, or timer handles. Doing so would make lifecycle correctness a caller obligation and leave the module shallow.

### 3. Server event publisher

Seam: wired-admin `publishNostrEvent`.

```ts
publishEvent(event, relayUrls, deadlineMs): Promise<PublishOutcome>
```

`PublishOutcome` may deepen from a string array to accepted/rejected/timeout/disconnect counts only when callers or status reporting need them; the accepted relay list remains authoritative. Connection cleanup and within-invocation target dedup stay internal. Owner-specific retry and ledger state stay outside.

### 4. Workflow measurement summary

Keep the common field vocabulary already proven by the transcript harness: workflow ID, connections opened/closed/reused, REQ/EVENT count and bytes, returned unique IDs, EOSE/close/timeout, relay fan-out, duplicate operations, acknowledgements/rejections, retries, and initial/complete duration. Production adapters must be content-free, bounded, and non-blocking.

This is a shared contract, not a shared package. The two harness implementations remain repo-local because their test runners, event types, and nostr-tools versions differ. Architecture ticket follow-up may add a small versioned JSON schema/conformance fixture if drift occurs; it should not publish a runtime dependency merely to remove test-code duplication.

## What stays workflow-local

| Concern | Owner | Reason not to centralize now |
| --- | --- | --- |
| Thread descendant traversal and live replacement | Wired thread workflow | Completeness and same-second handoff require a prototype; a generic subscription manager cannot choose the UX trade-off. |
| Feed frontier/chunk traversal | Each feed/snapshot workflow | Browser streams while server snapshots batch; caps must be replaced correctness-first before finding a stable shared interface. |
| Bootstrap/live ownership handoff | Wired feed hook | Ordinary overlap frequency is unknown and first-paint/live authority are UI semantics. |
| Root microtask batching and quote batching | Respective browser workflow | Controlled multiplicity exists, but timing equivalence and ordinary savings are not established. |
| Profile positive/in-flight cache | Wired enrichment owner | Newest-metadata and retry-after-miss semantics belong with profile selection, not relay transport. |
| Notification pagination/history | Notification owner | Cursors and history completeness are product semantics; transport only executes filters. |
| Snapshot cache and scheduler | Wired cache owner and wired-admin refresh owner | Both already coalesce in process. Deployment consumers/cadence are unknown, so choosing one producer now risks availability. |
| Revenue receipt retries | Revenue module | Persisted idempotency/settlement state is the only safe source of retry intent. |
| Preview endpoint coalescing | Preview/cache owner | Duplicate deployment frequency and safe freshness window are unmeasured. |

## Alternatives

| Alternative | Relay impact | UX risk | Complexity / coupling | Operability | Migration cost | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Continue only ad hoc local fixes | Captures known defects but lifecycle logic remains duplicated and future fixes can diverge. | Medium: late sockets, terminal waits, and hint omissions can recur. | Low initial, high ongoing locality cost. | Fragmented evidence. | Low now. | Reject as final architecture; retain local fixes as first migration slices. |
| One cross-repository TypeScript relay package | Could centralize mechanics, but no measured extra relay reduction over repo-local modules. | High during version/API unification; browser/server semantics can be flattened incorrectly. | High coupling across repositories and nostr-tools `2.5.1` versus `^2.23.8`. | Coordinated releases and package compatibility required. | High. | Reject now. Reconsider only after compatible dependency versions and two stable equivalent interfaces exist. |
| Route all access through the wired-admin gateway | Central connection point might enable pooling, but no deployed-load evidence supports it. | Very high: new network dependency, availability/freshness bottleneck, changed hint/privacy behavior. | High infrastructure and protocol coupling. | Central bottleneck and new capacity/SLO burden. | Very high. | Reject. |
| Permanent server connection pools | May reduce connects, but refresh cadence and serverless reuse are unknown. | Medium/high: stale connections, process lifecycle, and failure recovery change. | Medium/high. | Requires health, reconnect, drain, and deployment ownership. | Medium. | Reject until measurements show connects are material and runtime supports stable ownership. |
| Shared repo-local deep interfaces plus workflow-local semantics (chosen) | Removes proven lifecycle duplication within each runtime; enables later measured work without narrowing coverage. | Low when migrated expand-before-contract with transcript equivalence. | Moderate, low cross-repo coupling. | Consistent bounded status contract; runtime failures stay isolated. | Incremental. | Choose. |

## Compatibility and ownership

- Wired owns browser pooling, browser query/publish completion, serverless preview, and serverless feed snapshot/cache modules.
- wired-admin owns long-running refresh scheduling/session lifecycle, server publication, revenue retries, and the relay gateway.
- No production import crosses repositories. Shared documents and evidence schema are copied/versioned artifacts until dependency and interface compatibility are deliberately established.
- Wired currently uses nostr-tools `2.5.1` and ws `^8.21.0`; wired-admin uses nostr-tools `^2.23.8` and ws `^8.18.3`. Tests must pin behavior at each installed version, especially EOSE timers, terminal close, publish resolvers, and connect semantics.
- The deployment owner, not a shared module, decides public relay configuration, deadlines, and staging rollout.

## UX and controlled performance guardrails

Later slices must preserve exact result IDs/metadata/accepted relays and meet or improve the applicable controlled baseline under equivalent fixtures:

| Workflow | Guardrail |
| --- | --- |
| Browser thread | initial p95 ≤28 ms and complete p95 ≤48 ms; complete reachable descendants remains the overriding correctness requirement. |
| Browser referenced context | complete p95 ≤19 ms. |
| Server preview normal | p95 ≤34 ms; terminal-disconnect path must not wait after every relay is terminal; recursive completeness may require an separately approved completion target. |
| Browser feed | initial p95 ≤26 ms and complete p95 ≤50 ms. |
| Wired server snapshot | complete p95 ≤52 ms. |
| wired-admin snapshot | complete p95 ≤48 ms. |
| Notifications | complete p95 ≤39 ms with the exact authored/mention union. |
| Profiles | complete p95 ≤34 ms with newest metadata selection. |
| Quotes | complete p95 ≤23 ms with fallback-first and hint coverage. |
| Browser publication | partial-accept protocol p95 ≤9 ms; owner remains `publishing` until settlement and never labels an accepted post unpublished. |
| Server publication | partial-accept protocol p95 ≤21 ms and every obtained/late connection closes. |

These are local fixture regression guardrails, not production SLOs or relay-load estimates. Completeness fixes may legitimately add work; any changed target must be explicit and approved before rollout.

## Expand-before-migrate plan

1. **Pin contracts first.** Keep the current transcript fixtures and add failing lifecycle/completeness cases at the existing seam: connect-after-deadline, close-before-EOSE, all-fail, hints, navigation/refresh cancellation, exact outputs, and p95.
2. **Extract without changing callers.** Add repo-local finite-query/session implementations behind the existing functions. Keep old interfaces as adapters temporarily; compare transcripts and owner-visible output.
3. **Migrate one workflow at a time.** Suggested order: server preview lifecycle, Wired server snapshot lifecycle, wired-admin refresh lifecycle, then browser finite queries. Each slice owns its tests, measurement, rollout, and rollback.
4. **Contract old paths.** Delete replaced direct Relay/timer implementations and their implementation-level tests only after all callers use the deep module and interface-level tests cover them.
5. **Add correctness work separately.** Recursive preview, uncapped traversal/pagination, and dynamic hint coverage get independent slices because they may increase relay work and need new performance targets.
6. **Measure before optional dedup.** Only after status evidence exists should teams prototype bootstrap/live handoff, root/quote batching, profile in-flight ownership, preview coalescing, or one snapshot producer.

## Independently verifiable prefactoring slices

- Define `QueryCompletion` and measurement vocabulary with no production behavior change.
- Add server finite-session test adapters and terminal/late-connection tests in each repository.
- Move Wired preview direct-relay lifecycle behind its session interface with exact transcript equivalence.
- Move each snapshot producer behind its local session interface without changing filters, cache, or scheduler.
- Deepen browser finite-query completion while retaining the existing live-thread implementation as an internal compatibility path.
- Add content-free publishing outcome counters before choosing a browser deadline.
- Add a versioned transcript-summary JSON schema only if the two harnesses demonstrably drift.

## Rejected shortcuts

- No relay removal, first-relay/first-ACK completion, smaller limits, arbitrary `since`, permanent negative cache, or snapshot-only authority.
- No generic global dedup by event ID, filter, or refresh key without an owner-defined freshness/retry window.
- No timeout value derived from loopback p95.
- No cross-process lock or single snapshot producer until deployment overlap and consumers are observed.
- No claim that fewer client frames equals lower public relay load.

## Result

The recommended architecture is two repo-local deep lifecycle modules plus a separate publishing module and a shared evidence contract. It creates locality for proven connection/subscription mechanics while leaving traversal, caching, retries, and UX-sensitive batching with the workflows that can prove their invariants. Every migration can be transcript-compared and rolled back independently; no production optimization is implemented by this decision.
