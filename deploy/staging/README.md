# Wired Admin staging

The staging environment is exposed through the Cloudflare Tunnel hostname:

```text
https://staging.wiredsignal.online
```

The tunnel and DNS route are managed in Cloudflare. The compose stack only needs
the connector token in `CLOUDFLARED_TOKEN`; never commit that value.

## GitHub environment secrets

Create a protected `staging` environment with these secrets:

- `CLOUDFLARED_TOKEN`: connector token for the `wired-admin-staging` tunnel
- `STAGING_ADMIN_TOKEN`: admin API and cron token for staging

Optional environment variables:

- `STAGING_PATH`: deploy directory on the self-hosted runner, defaults to
  `/home/umbrel/wired-admin-staging`
- `STAGING_RELAY_MIN_POW`: defaults to `16`
- `STAGING_FEED_SNAPSHOT_AGE_HOURS`: defaults to `24`
- `STAGING_FEED_SNAPSHOT_REFRESH_SECONDS`: defaults to `300`

The deploy job runs on the existing self-hosted runner labels:

```yaml
[self-hosted, Linux, X64, umbrel, wired-admin]
```

That runner must have Docker Compose access.

## Local staging run

From this repository:

```sh
mkdir -p /home/umbrel/wired-admin-staging/deploy /home/umbrel/wired-admin-staging/data/web /home/umbrel/wired-admin-staging/data/strfry
cp deploy/staging/docker-compose.yml /home/umbrel/wired-admin-staging/deploy/docker-compose.yml
cp smolgrrr-wired-admin/strfry.conf /home/umbrel/wired-admin-staging/deploy/strfry.conf
```

Create `/home/umbrel/wired-admin-staging/deploy/.env`:

```sh
WIRED_ADMIN_IMAGE=ghcr.io/smolgrrr/wired-admin-web:staging-latest
WIRED_ADMIN_DATA_DIR=/home/umbrel/wired-admin-staging/data
WIRED_ADMIN_STRFRY_CONF=/home/umbrel/wired-admin-staging/deploy/strfry.conf
CLOUDFLARED_TOKEN=...
MODERATION_ADMIN_TOKEN=...
CRON_SECRET=...
```

Then deploy:

```sh
cd /home/umbrel/wired-admin-staging/deploy
docker compose --env-file .env -f docker-compose.yml up -d
```

## Wired client dev branches

Point any Wired client dev branch at staging with:

```sh
VITE_FEED_SNAPSHOT_URL=https://staging.wiredsignal.online/api/feed/bootstrap
VITE_MODERATION_MANIFEST_URL=https://staging.wiredsignal.online/api/moderation/manifest
VITE_POW_RELAYS=wss://staging.wiredsignal.online,wss://powrelay.xyz,wss://pow.relays.land
VITE_ENRICHMENT_RELAYS=wss://staging.wiredsignal.online,wss://relay.damus.io,wss://offchain.pub,wss://nos.lol,wss://relay.primal.net,wss://relay.nostr.band,wss://nostr.wine,wss://relay.snort.social
VITE_CONFESS_API_BASE=https://staging.wiredsignal.online
```
