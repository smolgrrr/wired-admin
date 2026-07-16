# wired-admin relay workflow status export

The admin exporter sends only fixed, bounded workflow aggregates to Wired's approved v1 ingest. It does not measure public-relay load and must not be interpreted as relay receipt, bandwidth, or cost. Event content, event IDs, pubkeys, relay URLs, secrets, and arbitrary labels are never included.

## Configuration and identity

Export is disabled unless every required setting is present:

```text
RELAY_WORKFLOW_STATUS_EXPORT_ENABLED=true
RELAY_WORKFLOW_STATUS_EXPORT_PERCENT=10
RELAY_WORKFLOW_STATUS_ENDPOINT=https://wiredsignal.online/api/workflow-status
WORKFLOW_STATUS_ADMIN_TOKEN=<independent high-entropy operator token>
```

`WORKFLOW_STATUS_ADMIN_TOKEN` must match the token configured on the Wired ingest and is sent only as a Bearer credential to `RELAY_WORKFLOW_STATUS_ENDPOINT`. The current named operator and deletion owner is the GitHub/Vercel account `smolgrrr` (`doot`). Access to the private Blob store remains project-scoped on the Wired deployment; wired-admin has write-only HTTP access and no list/read endpoint.

The destination enforces the `wired-admin` service identity, fixed owner/status enums, a 32 KiB envelope limit, 60 requests per source per minute, 1,000 aggregate rows per source per UTC day, and automatic deletion after 14 days. The exporter additionally caps its in-memory queue at 100 envelopes, drops the oldest on overflow, uses a five-second transport deadline, and increments one bounded local drop counter.

## Rollout and rollback

1. Keep export disabled while local collection and exact workflow outputs are verified.
2. Configure the endpoint and independent token, enable export at 10%, and verify accepted responses plus unchanged refresh/publish/API completion evidence for one deployment window.
3. Increase to 100% only while result identity and controlled p95 remain unchanged.

Set `RELAY_WORKFLOW_STATUS_EXPORT_PERCENT=0` or `RELAY_WORKFLOW_STATUS_EXPORT_ENABLED=false` for immediate rollback. The collector can be disabled separately with `RELAY_WORKFLOW_EVIDENCE_ENABLED=off`. Missing credentials, queue overflow, timeout, network failure, non-2xx response, or ingest outage drops status evidence only; refresh, publishing, and API completion never await export.

To delete a run, disable this exporter first, then have the named Wired deployment owner delete the private objects under `relay-workflow-status/v1/`. Re-enable only after identity, caps, retention, and access are reconfirmed.
