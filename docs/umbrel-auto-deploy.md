# Wired Admin Umbrel Auto Deploy

Wired Admin deploys from GitHub Actions after the web image publish job succeeds on a push to `main`.

The deploy job runs on a self-hosted GitHub Actions runner installed on the Umbrel host with these labels:

- `self-hosted`
- `umbrel`
- `wired-admin`

The deploy path intentionally avoids Umbrel's app update hook. It fast-forwards the app-store checkout on the host, updates only the installed `services.web.image` and `services.web.environment.RELAY_VERSION`, copies the packaged `umbrel-app.yml`, restarts the app through `umbreld client apps.restart.mutate`, then runs smoke checks.

## Required Host Setup

Install a repository-scoped self-hosted runner for `smolgrrr/wired-admin` on the Umbrel host and assign the labels `umbrel` and `wired-admin`.

The runner user must be able to run:

- `git`
- `node`
- `umbreld`

The runner user must also be able to write the installed app data files:

- `/home/umbrel/umbrel/app-data/smolgrrr-wired-admin/docker-compose.yml`
- `/home/umbrel/umbrel/app-data/smolgrrr-wired-admin/umbrel-app.yml`
- `/home/umbrel/umbrel/app-data/smolgrrr-wired-admin/backups/`

The runner should run only trusted deploy jobs from `main`. Do not run pull request workflows on this runner for a public repo.

## Optional GitHub Repository Variables

The workflow has working defaults for this host. Configure these repository variables only if paths or smoke URLs change:

- `UMBREL_DEPLOY_UMBREL_DIR`: Umbrel data directory, default `/home/umbrel/umbrel`.
- `UMBREL_DEPLOY_REPO_DIR`: App-store checkout path, default `/home/umbrel/dev/wired-pow-relay-app`.
- `UMBREL_DEPLOY_PUBLIC_BASE_URL`: Public base URL, default `https://wiredsignal.online`.
- `UMBREL_DEPLOY_PUBLIC_SMOKE_URLS`: Explicit comma- or whitespace-separated public URLs to check instead of deriving them from `UMBREL_DEPLOY_PUBLIC_BASE_URL`.

No SSH deploy secrets are required for the self-hosted runner path.

## Manual Host Run

From the app-store checkout on the Umbrel host:

```sh
node scripts/deploy-wired-admin-umbrel.mjs
```

Useful overrides:

```sh
UMBREL_DIR=/home/umbrel/umbrel \
WIRED_ADMIN_APP_STORE_DIR=/home/umbrel/dev/wired-pow-relay-app \
WIRED_ADMIN_PUBLIC_BASE_URL=https://wiredsignal.online \
node scripts/deploy-wired-admin-umbrel.mjs
```

For a no-write validation:

```sh
WIRED_ADMIN_DRY_RUN=1 WIRED_ADMIN_SKIP_RESTART=1 node scripts/deploy-wired-admin-umbrel.mjs
```

Backups are written under `app-data/smolgrrr-wired-admin/backups/auto-deploy-<UTC stamp>/`.
