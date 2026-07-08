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
```
