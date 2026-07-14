# Relay audit rubric

This is the common evidence and decision rubric for relay-efficiency work in Wired and wired-admin. It covers outbound reads and event publishing. An audit is not complete until every production relay operation is inventoried, measured where required, and assessed against the UX invariants below.

## Non-negotiable contract

**Relay coverage** means the configured relays and event-specific relay hints that Wired consults for a workflow. Complete results include every reply and required metadata reachable through that coverage, including recursive reply descendants. This is a bounded, testable contract; it is not a claim of global Nostr completeness.

**Relay efficiency improvement** means a reduction in outbound relay work—queries, subscriptions, connections, or event publishing—that preserves relay coverage, complete results, and timely user-visible behavior. Timeliness must not regress from the measured baseline and is evaluated with workflow-specific p95 targets.

Therefore, reject a proposal if it does any of the following:

- removes a configured relay or applicable event-specific relay hint from a workflow;
- makes a reachable reply, recursive descendant, quoted event, profile, or other required metadata unavailable;
- treats an arbitrary result limit, time window, cache entry, EOSE timeout, or first successful relay as proof of complete results;
- changes publishing targets, acceptance requirements, retry/failure behavior, or user-visible delivery semantics without an explicit equivalent-or-stronger delivery contract;
- worsens measured user-visible timeliness, including the workflow-specific p95, even if it reduces requests; or
- substitutes an estimate of public-relay load for static evidence or lightweight measurements.

Efficiency work may share connections, batch compatible filters, deduplicate identical work, cache without staleness, close work promptly, and narrow filters to the events a workflow actually needs. It may not silently exchange UX for lower relay traffic.

## Primary-source protocol baseline

The following NIPs are the applicable baseline. Audits should add another NIP only when an inventoried workflow uses its event kind, tag, or message flow.

### NIP-01: connections, requests, filters, and publishing

[NIP-01](https://github.com/nostr-protocol/nips/blob/8f8444d05a8842c40211ded5d10af3521541f865/01.md) defines the core client–relay protocol:

- A client should open one WebSocket per relay and use it for all subscriptions. Multiple subscriptions can coexist on that connection, so connection reuse and subscription reuse are separate questions.
- `REQ` both queries stored events and establishes a continuing subscription. A relay continues sending newly received matching events until the socket closes, the client sends `CLOSE` for the subscription ID, or another `REQ` replaces that ID.
- Conditions inside one filter are ANDed. Multiple filters in one `REQ` are ORed. `ids`, `authors`, `kinds`, tag filters, inclusive `since`/`until`, and `limit` are therefore the main breadth controls.
- `limit` guides only the initial stored-event response. A relay may return fewer results, and the limit is ignored for subsequent live events. It is not a completeness guarantee.
- `EOSE` marks the boundary between stored events and newly received real-time events. It does not terminate the subscription. A finite query must explicitly `CLOSE` (or close its connection) after its completion policy is satisfied.
- A relay can terminate or reject a subscription with `CLOSED`. Audits must retain the reason and distinguish that outcome from successful EOSE.
- A client publishes with `EVENT`. The relay must answer with `OK`; `true` means accepted and `false` means denied. The reason can classify outcomes such as `duplicate`, `blocked`, `rate-limited`, `invalid`, `restricted`, `mute`, or `error`. A duplicate may be an accepted `OK`, so outcome accounting must record the boolean and reason rather than infer success from an empty reason.

NIP-01 also defines kind `0` user metadata as replaceable and says relays should return only the latest matching replaceable event. Metadata audits must still preserve relay coverage and deterministic newest-event selection across relay results.

### NIP-10, NIP-19, and NIP-65: thread and relay coverage

[NIP-10](https://github.com/nostr-protocol/nips/blob/8f8444d05a8842c40211ded5d10af3521541f865/10.md) defines kind `1` thread relationships. Marked `e` tags identify `root` and direct `reply`, may carry a recommended relay URL, and may carry the referenced author's pubkey for outbox lookup when the hint does not resolve the event. An audit of thread resolution must cover both marked tags and the deprecated positional form that clients retain for backward compatibility. Fetching only direct children is not equivalent to resolving all recursive descendants.

[NIP-19](https://github.com/nostr-protocol/nips/blob/8f8444d05a8842c40211ded5d10af3521541f865/19.md) permits `nprofile`, `nevent`, and `naddr` identifiers to carry one or more relay hints where the entity is likely to be found. When such a reference starts a workflow, those hints are part of the operation's relay-selection evidence.

[NIP-65](https://github.com/nostr-protocol/nips/blob/8f8444d05a8842c40211ded5d10af3521541f865/65.md) distinguishes a user's write relays from relays where the user reads mentions. It recommends using write relays to download events from a user, read relays to download events about a tagged user, and both the author's write relays and tagged users' read relays when publishing. Where Wired implements this routing, an optimization must preserve those roles and resulting coverage rather than merely reduce fan-out.

### NIP-11 and NIP-42: relay constraints and authentication

[NIP-11](https://github.com/nostr-protocol/nips/blob/8f8444d05a8842c40211ded5d10af3521541f865/11.md) lets relays advertise practical constraints such as maximum subscriptions, message size, filter limit, and default limit. These values can explain rejection or truncation and can motivate batching or narrower filters. Because fields are optional and relay behavior can differ, they cannot by themselves prove result completeness or a real reduction in relay work.

[NIP-42](https://github.com/nostr-protocol/nips/blob/8f8444d05a8842c40211ded5d10af3521541f865/42.md) defines connection-scoped authentication and the `auth-required:` and `restricted:` prefixes. A rejected `REQ` uses `CLOSED`; a rejected publish uses `OK false`. After successful `AUTH`, a client may repeat the original request or publish. Audits must count that repeat as retry work and must not collapse authentication, rejection, and final delivery into one nominal attempt.

## Exact nostr-tools behavior in scope

The repositories do not use the same library generation. Wired pins [`nostr-tools@2.5.1`](https://registry.npmjs.org/nostr-tools/2.5.1), whose published `gitHead` is the tagged commit [`d0ae8b3`](https://github.com/nbd-wtf/nostr-tools/tree/d0ae8b36a2a351c4c19391400c23f9c8347c351e). The wired-admin web lockfile resolves [`nostr-tools@2.23.8`](https://registry.npmjs.org/nostr-tools/2.23.8), whose published `gitHead` is [`e9b40dc`](https://github.com/nbd-wtf/nostr-tools/tree/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8). Version-sensitive claims below link to those exact sources rather than current `master`.

### Wired: nostr-tools 2.5.1

- `Relay.connect(url)` creates and connects a new relay object; only repeated operations on that object reuse its socket. `SimplePool.ensureRelay` instead normalizes the URL, caches one relay object per URL, and reuses it ([Relay source](https://github.com/nbd-wtf/nostr-tools/blob/d0ae8b36a2a351c4c19391400c23f9c8347c351e/relay.ts), [pool source](https://github.com/nbd-wtf/nostr-tools/blob/d0ae8b36a2a351c4c19391400c23f9c8347c351e/abstract-pool.ts#L28-L48)). Auditors must identify which object owns each connection; importing `Relay` alone does not provide cross-call pooling.
- Direct connections default to a 4,400 ms connection timeout. There is no automatic reconnect. A hard connection failure closes subscriptions and rejects pending publishes ([relay source](https://github.com/nbd-wtf/nostr-tools/blob/d0ae8b36a2a351c4c19391400c23f9c8347c351e/abstract-relay.ts#L20-L124)).
- `subscribe` sends a `REQ`. Each subscription has a 4,400 ms default EOSE timer; expiration calls the same `oneose` path as a relay-sent EOSE. `close()` sends `CLOSE` while connected and removes the subscription locally ([subscription source](https://github.com/nbd-wtf/nostr-tools/blob/d0ae8b36a2a351c4c19391400c23f9c8347c351e/abstract-relay.ts#L296-L366)). Thus an EOSE callback is not, by itself, proof that every relay actually sent EOSE.
- `SimplePool.subscribeMany` opens one subscription per normalized relay, suppresses duplicate event IDs across those subscriptions, aggregates EOSE, and retains all live subscriptions until its returned closer is called. `subscribeManyEose` closes on aggregate EOSE; `querySync` uses that finite-query path ([pool source](https://github.com/nbd-wtf/nostr-tools/blob/d0ae8b36a2a351c4c19391400c23f9c8347c351e/abstract-pool.ts#L50-L184)). `maxWait` drives both the EOSE timer and a derived connection timeout; timeout completion is a client fallback, not relay evidence.
- `publish` stores a pending resolver keyed by event ID, sends `EVENT`, resolves on `OK true`, and rejects on `OK false` or connection teardown. It has no publish acknowledgement timeout and no automatic retry in this version ([relay source](https://github.com/nbd-wtf/nostr-tools/blob/d0ae8b36a2a351c4c19391400c23f9c8347c351e/abstract-relay.ts#L198-L253)). `SimplePool.publish` returns one promise per normalized relay and rejects duplicate URLs; the caller chooses all/any/quorum semantics ([pool source](https://github.com/nbd-wtf/nostr-tools/blob/d0ae8b36a2a351c4c19391400c23f9c8347c351e/abstract-pool.ts#L187-L197)).
- Closing a relay closes all its subscriptions, rejects pending publishes/counts, and closes the WebSocket. Closing only a finite subscription preserves the pooled socket for reuse ([relay cleanup](https://github.com/nbd-wtf/nostr-tools/blob/d0ae8b36a2a351c4c19391400c23f9c8347c351e/abstract-relay.ts#L56-L70), [relay close](https://github.com/nbd-wtf/nostr-tools/blob/d0ae8b36a2a351c4c19391400c23f9c8347c351e/abstract-relay.ts#L280-L284)).

### wired-admin web: nostr-tools 2.23.8

- `Relay.connect(url)` still creates a new relay object. With no options, direct `Relay.connect` supplies no connection timeout and has ping/reconnect disabled. `SimplePool` caches by normalized URL, defaults connection waits to 3,000 ms, and also leaves ping/reconnect disabled unless explicitly enabled ([Relay wrapper](https://github.com/nbd-wtf/nostr-tools/blob/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8/relay.ts), [pool wrapper](https://github.com/nbd-wtf/nostr-tools/blob/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8/pool.ts), [pool connection reuse](https://github.com/nbd-wtf/nostr-tools/blob/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8/abstract-pool.ts#L60-L120)). Application-level timeout wrappers therefore remain material evidence.
- Subscriptions still default to a 4,400 ms EOSE timer and send `CLOSE` when explicitly closed while connected. This release also supports `AbortSignal` cleanup ([subscription source](https://github.com/nbd-wtf/nostr-tools/blob/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8/abstract-relay.ts#L345-L373), [close source](https://github.com/nbd-wtf/nostr-tools/blob/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8/abstract-relay.ts#L534-L606)). `SimplePool` aggregates relay EOSE and close outcomes, deduplicates event IDs, and provides `subscribeEose`/`querySync` finite-query behavior ([pool subscription source](https://github.com/nbd-wtf/nostr-tools/blob/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8/abstract-pool.ts#L122-L319)).
- Direct `Relay.publish` has a 4,400 ms acknowledgement timeout and resolves/rejects from `OK`. `SimplePool.publish` produces one promise per normalized relay, rejects duplicate target URLs, and retries once only for `auth-required:` when the caller supplies an authentication function; it does not generally retry rate limits, network failures, or timeouts ([relay publish](https://github.com/nbd-wtf/nostr-tools/blob/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8/abstract-relay.ts#L288-L333), [pool publish](https://github.com/nbd-wtf/nostr-tools/blob/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8/abstract-pool.ts#L321-L375)). Notably, the pool's initial connection-failure branch returns a fulfilled string; callers must not equate every fulfilled per-relay promise with an `OK true` acknowledgement.
- Reconnection is opt-in. When enabled, the relay uses a backoff schedule, keeps open subscriptions, and resubscribes after reconnect; it advances each filter's `since` to one second after the greatest emitted timestamp ([reconnect source](https://github.com/nbd-wtf/nostr-tools/blob/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8/abstract-relay.ts#L92-L219)). Any use of this mode requires transcript tests around reconnect boundaries because timestamp mutation and replay/dedup behavior affect completeness.
- `SimplePool.close`, `destroy`, and `pruneIdleRelays` close sockets and remove cached relay objects. Subscription closure alone marks a relay idle but preserves it for reuse until explicit or idle cleanup ([pool cleanup](https://github.com/nbd-wtf/nostr-tools/blob/e9b40dca7c0bb3d19317ddf166c09e01c24ed8a8/abstract-pool.ts#L377-L402)).

## Operation inventory

Create one inventory row per distinct production operation. If one call site has materially different triggers, filters, relay selection, or lifecycle, split it into separate rows. Record exact values or an explicit `unknown—measure`; do not use `normal`, `small`, or `as needed`.

| Field | Required content |
| --- | --- |
| Operation ID | Stable audit identifier, repository, owning workflow, and accountable code/service owner. |
| User purpose | The user-visible or administrative outcome and why relay access is necessary. |
| Trigger and multiplicity | Every initiating trigger (mount, navigation, refresh, event, reply, author, timer, cron, retry), its cadence, concurrency, and all multiplicative dimensions. |
| Operation type | Finite query, live subscription, event publish, or a named compound sequence. |
| Library boundary | Exact nostr-tools version and API/object used (`Relay`, shared pool, application wrapper), including where the connection is owned. |
| Filter or event payload | Complete serialized filter set or event kind/tags/payload shape; identify which fields constrain breadth and which required data each admits. |
| Relay selection | Configured relays, event/NIP-19 hints, NIP-10 tag hints, NIP-65 routing, fallback order, normalization, and why this is the workflow's relay coverage. |
| Fan-out | Potential and observed relay count, concurrent/sequential policy, and publish success policy (all, any, quorum, or per-relay result). |
| Lifecycle | Start, finite/live classification, EOSE policy, timeout policy, `CLOSED` handling, `CLOSE`/abort/unmount/shutdown path, connection reuse, and expected/observed lifetime. |
| Batching | What compatible work is combined, maximum batch size, serialization/message-size constraints, and flush trigger. |
| Caching | Cache key, owner, positive/negative entries, freshness/invalidation, capacity, and whether cached results preserve required metadata and recursive replies. |
| Deduplication | URL, request, subscription, event, and publish dedup keys; scope and lifetime; behavior for simultaneous callers. |
| Retry behavior | Connection, query, authentication, publish, and acknowledgement retries; maximum attempts/backoff/jitter; idempotency; retryable reasons; cancellation. |
| Result and error contract | Completion criterion; EOSE-versus-timeout visibility; `CLOSED`, `NOTICE`, `OK`, rejection, partial relay failure, and user-visible failure behavior. |
| UX invariants | Relay coverage, complete reachable result set, required metadata, recursive descendants, publishing delivery behavior, and workflow-specific timeliness target. |
| Evidence | Static references plus the baseline measurement/run identifiers required by the rules below. |

For a compound workflow, also draw the sequence of operations and identify downstream multiplication—for example, one feed result causing per-author metadata queries or each discovered reply causing another relay fan-out.

## Evidence rules

### What static code evidence can establish

Static evidence is sufficient to establish deterministic facts visible in the repository and the pinned dependency source, including:

- the declared filters/event payload, configured targets, explicit fan-out, and library API/version;
- a missing reachable cleanup path, an unbounded live subscription, or a finite query that never calls its closer;
- deterministic duplicate calls, duplicate relay URLs, nested per-item query construction, missing batching, or a cache/dedup layer that is absent by construction;
- timeout, retry, acknowledgement, rejection, and error branches that do or do not exist; and
- an obviously overbroad filter relative to the workflow contract, such as requesting event kinds or authors that no downstream path can use.

Static evidence may justify calling a finding a defect, but it does not justify invented traffic totals, hit rates, latency effects, relay-side cost, or expected percentage reductions.

### What requires lightweight runtime evidence

Runtime evidence is required for claims about actual frequency, connection reuse, relay fan-out after normalization/fallbacks, subscription lifetime, returned breadth, bytes, duplication, caching, contention, timeout/retry rates, publishing outcomes, completeness, or user-visible latency. Changes involving request frequency, fan-out, caching, deduplication, pooling, refresh cadence, or batching require comparable before/after measurements even when the static defect is clear.

Measure representative normal sessions and local or staging workflows. Do not generate synthetic load against public relays. Capture, per operation and relay:

- attempted/opened/reused/closed connections;
- `REQ` and `CLOSE` count, serialized filters and bytes, EOSE received versus client EOSE timeout, `CLOSED` reasons, active peak, and subscription lifetime;
- returned event count and bytes, unique IDs, duplicate IDs, required-result IDs, metadata resolution, reply depth, and unresolved references within relay coverage;
- cache requests/hits/misses/stale revalidations and deduplicated/coalesced caller counts;
- outbound `EVENT` count and bytes, target fan-out, `OK true`, `OK false` and reason, missing-OK timeout, connection failure, authentication attempt, retry, and final per-relay disposition; and
- workflow completion latency (at least p50 and p95), time to initial useful content, and time until all reachable replies and required metadata have resolved.

Keep raw transcripts or machine-readable summaries with run ID, commit, environment, scenario, relay fixture/configuration, start/end time, sample size, and instrumentation version. A before/after comparison is valid only when those inputs and the relay coverage are equivalent. Public-relay observations may be recorded from ordinary use, but they are noisy evidence and must not be represented as controlled relay-load measurements.

### Required behavioral seam

Prefer the highest existing workflow boundary and a controllable fake relay. Assert an observable transcript containing connections, `REQ`, serialized filters, returned events/bytes, EOSE, `CLOSE`, subscription lifetime, `EVENT`, `OK`, rejections, timeouts, retries, fan-out, and completion latency. The fixture must exercise slow/missing EOSE, `CLOSED`, duplicate events from multiple relays, recursive replies, missing-then-resolved metadata, `OK false`, absent `OK`, partial relay failure, and cleanup/cancellation. Lower-level filter tests are supplemental when an edge cannot be observed through the workflow seam.

## Recommendation record

Every recommendation must be independently reviewable and must contain all of the following:

1. **Identity and ownership:** recommendation ID, affected operation IDs/workflows/repositories, implementation owner, and operational owner.
2. **Evidence:** static references, baseline run IDs, the observed mechanism of waste, and any uncertainty. Separate facts from inference.
3. **Proposed change:** the smallest complete behavioral change, including lifecycle, relay selection, filters/payload, batching/cache/dedup keys, retry, and error semantics where affected.
4. **Expected relay impact:** directional changes in connections, `REQ`/`CLOSE`, filter/payload bytes, returned events/bytes, subscription lifetime, publish attempts, fan-out, or retries. Give a numeric estimate only when baseline evidence supports it; otherwise specify the metric the experiment will determine.
5. **Confidence:** high/medium/low with a reason tied to evidence quality, not intuition.
6. **Preserved UX invariants:** explicit proof obligations for unchanged relay coverage, all reachable replies and recursive descendants, required metadata, publishing delivery behavior, error visibility, initial-content latency, completion latency, and workflow p95.
7. **Rejected alternatives:** at least the plausible lower-load alternative that was rejected for reducing coverage, completeness, delivery, timeliness, or for adding unjustified architectural complexity.
8. **Verification:** highest-seam transcript tests, before/after scenario and sample, expected result-set equivalence, per-relay publishing disposition, and measurable pass thresholds.
9. **Rollout:** feature flag or staged scope where warranted, instrumentation and observation window, dashboards/logs, stop conditions, and responsible observer.
10. **Rollback:** reversible action, trigger thresholds (including any p95 or completeness regression), data/cache cleanup if needed, and how the previous behavior is restored without losing pending publishes.

A recommendation is ready for implementation only when its proof obligations preserve the non-negotiable contract. Architectural changes such as shared pooling, cross-workflow deduplication, or common caching must additionally show why simpler local lifecycle/filter fixes do not deliver the same verified reduction.

## Audit exit criteria

An audit slice is complete only when:

- every production operation in its workflow has a complete inventory row;
- static findings cite both application code and the applicable exact dependency/protocol behavior;
- runtime-sensitive findings have representative baseline evidence rather than guessed relay load;
- each recommendation uses the complete record above and rejects UX-trading alternatives;
- verification compares result identity/coverage and publish disposition, not merely request counts; and
- unknowns are carried forward as explicit measurement work, never silently converted into assumptions.
