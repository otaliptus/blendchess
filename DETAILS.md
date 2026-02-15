# Blendchess Project Details

## Project shape

- Frontend: static browser app (`index.html`, `style.css`, `app.js`).
- Shared game logic: `chess-core.js`.
- Client guards: `client/stateGuards.js`.
- Optional Node backend: `server/`.
- Optional Cloudflare backend: `ws-worker/`.

## Gameplay modes

- Local pass-and-play in one browser.
- Online friend mode via websocket room backend.
- Spectator mode for online rooms.

## State model highlights

- Board is 8x8 of piece objects `{ type, color, hasMoved }`.
- Authoritative online snapshots include `boardVersion`.
- Client hydration rejects stale versions.
- Saved history snapshots are shape-validated before load.

## Current backend topology notes

- Node server uses in-memory rooms and TTL pruning.
- Worker backend currently routes through one Durable Object hub (`global-hub`).
- For high scale, room-sharded Durable Object routing is recommended.
