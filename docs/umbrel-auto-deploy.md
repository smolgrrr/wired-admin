# Wired Admin Umbrel Auto Deploy

Wired Admin deploys from GitHub Actions after the web image publish job succeeds on a push to `main`.

The deploy path intentionally avoids Umbrel's app update hook. It SSHes to the Umbrel host, fast-forwards the app-store checkout, updates only the installed `services.web.image` and `services.web.environment.RELAY_VERSION`, copies the packaged `umbrel-app.yml`, restarts the app through `umbreld client apps.restart.mutate`, then runs smoke checks.

## Required GitHub Secrets

Configure these repository secrets:

- `UMBREL_DEPLOY_SSH_HOST`: Umbrel host or IP reachable from GitHub Actions.
- `UMBREL_DEPLOY_SSH_USER`: SSH user on the Umbrel host.
- `UMBREL_DEPLOY_SSH_KEY`: Private key for that SSH user.

Recommended:

- `UMBREL_DEPLOY_SSH_KNOWN_HOSTS`: The host key line for strict SSH host verification. If omitted, the workflow uses `ssh-keyscan` during the run.

Optional:

- `UMBREL_DEPLOY_SSH_PORT`: SSH port, default `22`.
- `UMBREL_DEPLOY_UMBREL_DIR`: Umbrel data directory, default `/home/umbrel/umbrel`.
- `UMBREL_DEPLOY_REPO_DIR`: Exact app-store checkout path if auto-discovery is not enough.
- `UMBREL_DEPLOY_PUBLIC_BASE_URL`: Public base URL. When set, the deploy checks `/api/confess/status` and `/api/feed/bootstrap`.
- `UMBREL_DEPLOY_PUBLIC_SMOKE_URLS`: Explicit comma- or whitespace-separated public URLs to check instead of deriving them from `UMBREL_DEPLOY_PUBLIC_BASE_URL`.

If any required SSH secret is absent, the deploy job exits successfully with a notice and does not contact the server.

## One-Time Host Setup

1. Install the public key matching `UMBREL_DEPLOY_SSH_KEY` for the deploy user.
2. Make sure that user can run `git`, `node`, and `umbreld`.
3. Make sure the deploy user can write the installed app data files:
   - `/home/umbrel/umbrel/app-data/smolgrrr-wired-admin/docker-compose.yml`
   - `/home/umbrel/umbrel/app-data/smolgrrr-wired-admin/umbrel-app.yml`
   - `/home/umbrel/umbrel/app-data/smolgrrr-wired-admin/backups/`
4. Make sure the deploy user can fast-forward the app-store checkout that contains `smolgrrr-wired-admin`.

The default checkout discovery searches:

- `/home/umbrel/umbrel/app-stores/*`
- `/home/umbrel/umbrel/repos/*`
- the remote SSH working directory

Set `UMBREL_DEPLOY_REPO_DIR` if the checkout lives somewhere else.

## Manual Host Run

From the app-store checkout on the Umbrel host:

```sh
node scripts/deploy-wired-admin-umbrel.mjs
```

Useful overrides:

```sh
UMBREL_DIR=/home/umbrel/umbrel \
WIRED_ADMIN_APP_STORE_DIR=/home/umbrel/umbrel/app-stores/smolgrrr-wired-admin-github-957d0d1c \
WIRED_ADMIN_PUBLIC_BASE_URL=https://wiredsignal.online \
node scripts/deploy-wired-admin-umbrel.mjs
```

For a no-write validation:

```sh
WIRED_ADMIN_DRY_RUN=1 WIRED_ADMIN_SKIP_RESTART=1 node scripts/deploy-wired-admin-umbrel.mjs
```

Backups are written under `app-data/smolgrrr-wired-admin/backups/auto-deploy-<UTC stamp>/`.
