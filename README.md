# Wired Admin Umbrel App

Community Umbrel app store for Wired's relay, snapshot, and moderation admin service.

The app runs a `strfry` relay as the durable backend and exposes a small Node
gateway that:

- serves a local Umbrel relay, feed snapshot, and moderation console,
- exposes NIP-11 relay metadata,
- proxies Nostr WebSocket traffic to `strfry`,
- rejects publish attempts that do not meet the configured NIP-13 PoW floor,
- serves a Wired feed bootstrap snapshot at `/api/feed/bootstrap`,
- serves public client-side moderation filtering data at `/api/moderation/manifest`,
- signs and publishes high-PoW Wired account posts at `/api/wired-account/posts`,
- keeps moderation management actions local to the Umbrel app.

Persistent app data is stored under Umbrel app data:

- `data/strfry` for the relay database,
- `data/web/feed-bootstrap.json` for the feed snapshot cache,
- `data/web/moderation.json` for moderation actions.
- `data/web/media-moderation.json` for media verdicts, hashes, durable jobs, and
  administrator override audit records.
- `data/web/wired-account.json` for Wired account post audit records.

The community app enables `MODERATION_ADMIN_OPEN=true` for the local Umbrel
console only. Hosts listed in `PUBLIC_HOSTS` cannot access the UI,
`/api/status`, `/api/cron/refresh-feed`, or `/api/moderation/actions`. Public
hosts only receive Nostr relay/NIP-11 traffic, `/api/feed/bootstrap`,
`/api/moderation/manifest`, and the Wired account posting API. `PUBLIC_HOSTS`
supports exact hosts and suffix patterns such as `*.vercel.app` and `*.onion`;
Vercel preview deployments are frontend origins and only need the public
snapshot/manifest/relay/account endpoints.

## Media moderation

Wired Admin can classify note and reply images, animated images, and videos
before the Wired client reveals them. Audio, avatars, profile metadata, emoji,
and link previews are deliberately outside this first rollout.

The service uses a bundled NSFWJS MobileNetV2 model through pure TensorFlow.js;
model inference is local and does not call a third-party classification API. It
also computes SHA-256 and 64-bit difference hashes locally. Configured exact or
perceptual matches block before model classification. Media bytes are fetched
with private-address and redirect checks, a 25 MiB limit, and timeouts. Bytes
and extracted video frames are transient; the persistent store holds the media
URL, hashes, verdict, detector version, timestamps, jobs, overrides, and audit
metadata, not a copy of the media.

This is a content-safety classifier, not a legal determination system. Legal
classification, reporting, preservation, appeals, and qualified third-party
hash-list integrations are deferred work.

Runtime environment:

- `MEDIA_MODERATION_MODE`: `off` (default), `shadow`, or `enforce`. Shadow mode
  evaluates and records decisions without asking clients to hide media.
- `MEDIA_MODERATION_STORE_FILE`: persistent JSON store path.
- `MEDIA_MODERATION_BLOCK_THRESHOLD`: Porn/Hentai high-confidence review
  threshold, default `0.92`. Local model output alone never makes a legal or
  whole-note block decision.
- `MEDIA_MODERATION_REVIEW_THRESHOLD`: Porn/Hentai/Sexy review threshold,
  default `0.65`. Review-required media remains covered in enforcement mode.
- `MEDIA_MODERATION_BLOCK_SHA256`: comma-separated local exact block hashes.
- `MEDIA_MODERATION_BLOCK_DHASH`: comma-separated local 16-character difference
  hashes; matches within Hamming distance 4 block.

The public client contract is `POST /api/media-moderation/verdicts`, with at
most 100 event-bound attachments per request. `GET /api/media-moderation/status`
exposes mode, detector version, queue depth, concurrency, counters, and observed
p95 scan latency without exposing verdict data. The local admin console lists
verdicts and audit entries and supports re-scan plus audited URL/SHA-256 allow
or block overrides. Automatic URL verdicts expire after 15 minutes; content
hash cache entries expire after seven days. Pending and unavailable decisions
are never revealed by an enforcing client.

Roll out in this order: server `shadow`, client `shadow`, inspect latency and
false positives, then enable a small client cohort in `enforce`. Roll back
immediately by setting either side to `off`; no media-hosting or CDN path is
changed by this feature.

## Wired Account Posts

Wired clients mine a kind 1 Nostr event template whose `pubkey` is the Wired
account pubkey. If the selected PoW target is at or above the configured
threshold, the client submits `{ "event": ... }` to
`POST /api/wired-account/posts`. Wired Admin verifies the NIP-13 nonce/proof,
signs the same event template with the configured Wired account key, publishes
it to relays, and records an audit entry.

Runtime environment:

- `WIRED_NOSTR_SECRET_KEY`: Wired account private key as `nsec` or 32-byte hex.
  Do not commit a real value. If unset, the server falls back to
  `CONFESS_NOSTR_SECRET_KEY` for migration.
- `WIRED_ACCOUNT_MIN_POW`: minimum NIP-13 target/proof, falling back to
  `CONFESS_MIN_POW` and then `RELAY_MIN_POW`.
- `WIRED_ACCOUNT_RELAYS`: comma-separated publish relays, falling back to
  Confess/thread relays.
- `WIRED_ACCOUNT_CONTENT_MAX_LENGTH`: post length limit, defaulting to the
  Confess content limit.
- `WIRED_ACCOUNT_STORE_FILE`: audit store path, defaulting to
  `data/web/wired-account.json` in the Umbrel app.

## Install

Add this repository as a Community App Store in umbrelOS, then install
`Wired Admin`.

## Local development

```sh
cd smolgrrr-wired-admin
docker compose up --build
```

Then open `http://localhost:3000`.

## Confess X Mirror

The Confess X mirror is server-side only and disabled by default. A Confess
submission publishes to Nostr first; X posting is queued afterward and X
rejection or downtime does not block the Nostr confession.

The mirror uses X OAuth1 user-context credentials generated for the dedicated X
account. OAuth2 is not used.

Runtime environment:

- `CONFESS_X_ENABLED`: set `true` to queue mirror attempts.
- `CONFESS_X_DRY_RUN`: defaults to `true`; set `false` only when ready to post.
- `CONFESS_X_OAUTH1_API_KEY`: app API key.
- `CONFESS_X_OAUTH1_API_SECRET`: app API key secret.
- `CONFESS_X_OAUTH1_ACCESS_TOKEN`: dedicated account access token.
- `CONFESS_X_OAUTH1_ACCESS_SECRET`: dedicated account access token secret.
- `CONFESS_X_ACCOUNT_HANDLE`: optional operator label for status output.
- `CONFESS_X_THREAD_BASE_URL`: base URL for automatic X replies linking to
  the Wired thread, defaults to `https://wiredsignal.online/thread`.

Before posting, the backend applies conservative X safety gates: no links/media,
no X mentions, no hashtags/cashtags, no obvious private information, and strict
blocking for high-risk harassment, threats, self-harm encouragement, scams, and
sexual-minor patterns. Blocked X mirrors are recorded on the Confess ledger but
the Nostr event remains published.

After the main X post succeeds, the mirror posts a reply to that X post with the
Wired thread URL. If the reply fails after the original X post succeeds, retries
reuse the stored original X post ID and only retry the reply.
