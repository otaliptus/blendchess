# Blendchess Details

This file is a short index. Full docs are:

- `README.md`: product overview and local run paths.
- `ARCHITECTURE.md`: system flow and component boundaries.
- `GAMEPLAY_EXPECTATIONS.md`: expected behavior and non-goals.
- `multiplayer-schema.md`: websocket protocol message schema.

## Project shape

- Frontend: static browser app (`index.html`, `style.css`, `app.js`).
- Shared game logic: `chess-core.js`.
- Client guards: `client/stateGuards.js`.
- Node multiplayer backend: `server/`.
- Cloudflare Worker multiplayer backend: `ws-worker/`.

## Supported modes

- Local pass-and-play.
- Online friend room play (authoritative server/worker).
- Spectator mode (read-only).

## Critical behavior currently implemented

- Stale online snapshots are rejected by version monotonicity checks.
- Local history snapshots are validated before load/clone.
- Hard mode can forfeit turn on illegal move while in check.
- Spectator header displays count (`Spectators: N`) rather than names.
- PGN export is only enabled after game over.

## Backend topology note

- Node path: in-memory room authority with TTL cleanup.
- Worker path: currently one Durable Object hub (`global-hub`) for all rooms.
- Scale-oriented next step: route by room code to sharded Durable Objects.
