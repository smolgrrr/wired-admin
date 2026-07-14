# Wired Admin staging

The staging environment is exposed through the Cloudflare Tunnel hostname:

```text
https://staging.wiredsignal.online
```

The tunnel and DNS route are managed by the existing Umbrel Cloudflare Tunnel
app. Staging is installed as its own Umbrel app, `smolgrrr-wired-admin-staging`,
and the existing `wired` tunnel routes `staging.wiredsignal.online` to port
`3002`.

## GitHub environment secrets

Create a protected `staging` environment with these secrets:

- `STAGING_ADMIN_TOKEN`: admin API and cron token for staging
- `STAGING_WIRED_NOSTR_SECRET_KEY`: staging-only Wired account private key as
  `nsec` or 32-byte hex; do not reuse the production key
- `STAGING_REVENUE_ENCRYPTION_KEY`: staging-only 32-byte hex key used to encrypt
  creator payout snapshots

Managed-wallet secrets are optional while staging uses FakeWallet. For Spark:

- `STAGING_REVENUE_SPARK_MNEMONIC`: staging-only BIP-39 mnemonic controlling
  the Spark wallet; store it only as a protected GitHub environment secret

Spark's non-secret settings are configured as GitHub environment variables:

- `STAGING_REVENUE_SPARK_NETWORK`: defaults to `MAINNET`
- `STAGING_REVENUE_SPARK_ACCOUNT_NUMBER`: defaults to Spark's mainnet account `1`
- `STAGING_REVENUE_SPARK_MAX_FEE_SATS`: defaults to `5` and must remain aligned
  with `STAGING_REVENUE_MAX_ROUTING_FEE_MSAT`
- `STAGING_REVENUE_DATABASE_FILE`: defaults to `/app/data/revenue.sqlite`; retain
  the existing configured path when migrating so settled accounting is preserved

The older LNbits adapter uses these secrets:

- `STAGING_REVENUE_LNBITS_ENDPOINT`: HTTPS base URL of the managed LNbits instance
- `STAGING_REVENUE_LNBITS_INVOICE_KEY`: invoice/read key for the Wired wallet
- `STAGING_REVENUE_LNBITS_ADMIN_KEY`: payment-capable admin key for the same wallet
- `STAGING_REVENUE_ENCRYPTION_PREVIOUS_KEYS`: JSON object of historical key
  versions to 32-byte hex keys, required only after rotating the current key

Optional environment variables:

- `STAGING_APP_STORE_DIR`: local Umbrel app-store checkout, defaults to
  `/home/umbrel/umbrel/app-stores/smolgrrr-wired-admin-github-957d0d1c`
- `STAGING_UMBREL_DIR`: Umbrel data directory, defaults to `/home/umbrel/umbrel`
- `STAGING_UMBREL_TRPC_ENDPOINT`: local Umbrel tRPC endpoint, defaults to
  `http://localhost/trpc`
- `STAGING_PORT`: host port routed by Cloudflare, defaults to `3002`
- `STAGING_RELAY_MIN_POW`: defaults to `16`
- `STAGING_FEED_SNAPSHOT_AGE_HOURS`: defaults to `24`
- `STAGING_FEED_SNAPSHOT_REFRESH_SECONDS`: defaults to `300`
- `STAGING_WIRED_ACCOUNT_MIN_POW`: defaults to `STAGING_RELAY_MIN_POW`, then
  `16`
- `STAGING_WIRED_ACCOUNT_RELAYS`: optional comma-separated publish relays
- `STAGING_REVENUE_WALLET_BACKEND`: `fake` by default; set to `spark` after the
  Spark mnemonic is configured; `lnbits` remains available for the older adapter
- `STAGING_REVENUE_ENCRYPTION_KEY_VERSION`: defaults to `1`; increment on key
  rotation and retain old keys in `STAGING_REVENUE_ENCRYPTION_PREVIOUS_KEYS`
- `STAGING_REVENUE_MAX_ROUTING_FEE_MSAT`: defaults to `5000`
- `STAGING_REVENUE_PAYMENT_NOT_FOUND_GRACE_MS`: defaults to `86400000` (24
  hours), during which an unindexed outgoing payment remains reserved to prevent
  a retry from double-paying
- `STAGING_REVENUE_ACCEPT_ENROLLMENTS`: defaults to `true`
- `STAGING_REVENUE_ACCEPT_INVOICES`: defaults to `true`; set `false` to stop new
  financial liabilities
- `STAGING_REVENUE_SEND_PAYOUTS`: defaults to `false` for the staged real-sat
  canary; set `true` only after reconciling the incoming zap
- `STAGING_REVENUE_MINIMUM_PAYOUT_MSAT`: defaults to `14000`, so a standard
  21-sat zap can immediately release its 14-sat whole-satoshi creator share
- `STAGING_REVENUE_MIN_SENDABLE_MSAT`: defaults to `1000`
- `STAGING_REVENUE_MAX_SENDABLE_MSAT`: defaults to `21000` during the canary and
  is enforced by the callback, not only advertised in LNURL metadata
- `STAGING_SMOKE_BASE_URL`: smoke-test base URL, defaults to the local Umbrel app
  URL on `STAGING_PORT`
- `STAGING_PUBLIC_SMOKE_URLS`: optional public URLs for the deploy helper to
  check after the local app is ready

The deploy job runs on the existing self-hosted runner labels:

```yaml
[self-hosted, Linux, X64, umbrel, wired-admin]
```

That runner must be able to run `node` and `umbreld`. It does not need direct
Docker socket access; container pulls and restarts happen through the running
Umbrel daemon.

## Local staging run

From this repository:

```sh
UMBREL_DIR=/home/umbrel/umbrel \
WIRED_ADMIN_APP_ID=smolgrrr-wired-admin-staging \
WIRED_ADMIN_APP_STORE_REPOSITORY_URL=https://github.com/smolgrrr/wired-admin.git \
WIRED_ADMIN_APP_STORE_DIR=/home/umbrel/umbrel/app-stores/smolgrrr-wired-admin-github-957d0d1c \
WIRED_ADMIN_SOURCE_PACKAGE_DIR=smolgrrr-wired-admin-staging \
WIRED_ADMIN_SYNC_PACKAGE_TO_APP_STORE=1 \
WIRED_ADMIN_IMAGE_OVERRIDE=ghcr.io/smolgrrr/wired-admin-web:staging-latest \
WIRED_ADMIN_RELAY_VERSION_OVERRIDE=staging-local \
WIRED_ADMIN_MANIFEST_VERSION_OVERRIDE=staging \
WIRED_ADMIN_ALLOW_VERSION_MISMATCH=1 \
WIRED_ADMIN_LOCAL_BASE_URL=http://127.0.0.1:3002 \
WIRED_ADMIN_SET_MODERATION_ADMIN_TOKEN=... \
WIRED_ADMIN_SET_CRON_SECRET=... \
WIRED_ADMIN_SET_WIRED_NOSTR_SECRET_KEY=... \
node scripts/deploy-wired-admin-umbrel.mjs
```

## Wired client dev branches

Point any Wired client dev branch at staging with:

```sh
VITE_FEED_SNAPSHOT_URL=https://staging.wiredsignal.online/api/feed/bootstrap
VITE_MODERATION_MANIFEST_URL=https://staging.wiredsignal.online/api/moderation/manifest
VITE_POW_RELAYS=wss://staging.wiredsignal.online,wss://powrelay.xyz,wss://pow.relays.land
VITE_ENRICHMENT_RELAYS=wss://staging.wiredsignal.online,wss://relay.damus.io,wss://offchain.pub,wss://nos.lol,wss://relay.primal.net,wss://relay.nostr.band,wss://nostr.wine,wss://relay.snort.social
VITE_CONFESS_API_BASE=https://staging.wiredsignal.online
VITE_WIRED_ACCOUNT_API_BASE=https://staging.wiredsignal.online
VITE_REVENUE_API_BASE=https://staging.wiredsignal.online
```

## Revenue testing and managed-wallet cutover

Staging deploys with FakeWallet. Use it to verify enrollment, NIP-57 invoice
creation, the exact 70/30 ledger split, receipt publication, the 14-sat payout
threshold, and deferred payout behavior without spending sats.

For the final real-sat canary, configure the Spark settings above, set
`STAGING_REVENUE_WALLET_BACKEND=spark`, and rerun the staging workflow. Start
with one low-value funding payment followed by one 21-sat zap, and confirm the
operator status endpoint reports the 14-sat creator payout before increasing
volume. Spark does not require Wired to run a Lightning node or manage channels.

Follow the bounded procedure in [spark-real-sat-canary.md](spark-real-sat-canary.md).
