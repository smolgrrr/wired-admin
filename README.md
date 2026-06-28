# Wired PoW Relay Umbrel App

Community Umbrel app store for a Wired-oriented Nostr proof-of-work relay.

The app runs a `strfry` relay as the durable backend and exposes a small Node
gateway that:

- serves a monitoring dashboard,
- exposes NIP-11 relay metadata,
- proxies Nostr WebSocket traffic to `strfry`,
- rejects publish attempts that do not meet the configured NIP-13 PoW floor.

## Install

Add this repository as a Community App Store in umbrelOS, then install
`Wired PoW Relay`.

## Local development

```sh
cd smolgrrr-wired-pow-relay
docker compose up --build
```

Then open `http://localhost:3000`.
