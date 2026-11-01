# Blendchess multiplayer Node server

Authoritative WebSocket backend for online games.

## Run

```bash
cd server
npm install
npm start            # ws://localhost:3000, override with PORT=5000
```

## Test

```bash
npm test
```

Runs the engine perft suite, room logic, rated rooms and watching, Elo and matchmaking, accounts and the
HTTP API (with a stand-in authenticator), session handling against a fake transport, and end-to-end
suites that spawn this server and play games over real sockets (private rooms, the full ranked flow from
queue to rating to profile and replay, and account keys across two devices). Point `E2E_URL` at another server
(e.g. `wrangler dev`) to run the end-to-end suites there instead.

## How it fits together

- `server.js` is only the transport: a map of rooms, each with its set of connections, plus size and rate limits, a room cap and TTL pruning. It also hosts the ranked lobby (`?lobby=1`) with an in-memory store and serves the HTTP API (`/api/*`, see `../multiplayer-schema.md`). Everything is in memory: a restart forgets accounts and games.
- Lobby rooms report results to the lobby once per game; clocks, no-show deadlines and the report retry run on a 500 ms ticker. `NEW_PLAYER_LIMIT` widens the per-network new-identity cap for local testing, and `SITE_ORIGINS` (comma-separated) sets which sites may use the account routes (`localhost` always may).
- Passkeys work against this server from `http://localhost:<port>`: serve the site from `localhost` (not `127.0.0.1`, which cannot hold a passkey).
- `shared.js` loads the shared modules from the repo root.
- Everything else, including joins, resumes, moves, draws, options and per-viewer redaction, lives in `../shared/room-session.js` and `../shared/room-logic.js`. The Cloudflare Worker uses the same code.

Protocol: `../multiplayer-schema.md`.
