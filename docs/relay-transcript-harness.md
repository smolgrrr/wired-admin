# Relay transcript harness

The relay transcript harness is the common behavioral measurement seam for the Wired and wired-admin relay-efficiency audits. It runs a local WebSocket relay fixture and exercises the same public workflow entry points that production uses. It never connects to a public relay.

Both repositories keep a test-local implementation with the same transcript contract. Sharing the contract now lets the audits compare workflows consistently without prematurely introducing a cross-repository package; the architecture ticket decides whether maintaining a shared package is justified.

## What it records

Each entry includes a timestamp, local relay URL, and connection identity. Depending on the operation it also records:

- connection open and close;
- `REQ`, subscription identity, complete filters, and request bytes;
- returned event identity and bytes;
- relay-sent EOSE;
- client-sent `CLOSE` and subscription lifetime;
- published `EVENT` identity and bytes; and
- `OK` acceptance or rejection and its reason.

The workflow summary adds connection reuse, request and close counts, returned and published bytes, successful and rejected acknowledgements, explicit retries, repeated operations, relay fan-out, subscription lifetimes, and completion latency. Completing a workflow freezes its transcript boundary so later relay activity cannot alter the result.

Repeated requests are counted when their serialized filters are identical. Repeated publishes are counted by event ID. This is an observable classification, not a claim about caller intent or retry policy. A workflow records a retry explicitly at the public workflow boundary, where the caller's intent is known.

## Driving relay behavior

The fixture callback for a request can return signed events, send EOSE, delay either response, or close the connection. The publish callback can delay and return either `OK true` or `OK false`, or close without acknowledging. Withholding EOSE lets the application's real EOSE timeout run; the transcript then shows a client `CLOSE` with no preceding relay EOSE and the measured lifetime. Withholding `OK` similarly lets the application's acknowledgement timeout or cancellation policy run.

One `RelayTranscriptSession` can aggregate several local relay fixtures. This makes fan-out a count of distinct relay URLs touched by a workflow rather than a value inferred from one fixture.

`waitFor` is the deterministic completion signal for tests. Assertions should wait for protocol behavior—such as the expected number of `CLOSE` messages—instead of sleeping. Small response delays are reserved for scenarios whose behavior specifically depends on ordering or failure.

## Measuring a workflow

1. Start the local relay fixture with only the responses needed by the scenario.
2. Begin a named workflow capture before the application opens its first connection.
3. Exercise the highest public browser or server workflow boundary.
4. Wait for the expected output and protocol completion signals.
5. Complete the capture and retain both the workflow output and transcript summary.
6. Close the fixture so no sockets or timers leak into later runs.

The Wired demonstration exercises the global-feed subscription through its public workflow entry point. The wired-admin demonstration exercises a complete feed-snapshot refresh through its service boundary. Together they prove result identity, recursive reply enrichment, finite-query EOSE/CLOSE behavior, connection reuse, returned bytes, and completion timing. Additional fixture tests cover delayed events, connection failure, client EOSE timeout, publish rejection, successful retry, and acknowledgement accounting.

## Audit evidence

For each repeatable baseline, store the run ID, commit, environment, scenario, fixture configuration, relay coverage, start/end time, sample size, and harness version beside the machine-readable summary. Compare result IDs and required metadata before comparing request counts or latency.

The local fixture gives deterministic correctness and request-shape evidence. It does not estimate public-relay traffic. Ordinary staging observations may complement it, but must retain equivalent relay coverage and must not generate synthetic public-relay load.

Workflow-specific p50 and p95 values require repeated normal runs. Unit-test wall-clock durations are not performance baselines; they only verify that completion timing is captured.
