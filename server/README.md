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

Runs the engine perft suite, room logic, session handling against a fake transport, and an end-to-end
suite that spawns this server and plays games over real sockets. Point `E2E_URL` at another server
(e.g. `wrangler dev`) to run the end-to-end suite there instead.

## How it fits together

- `server.js` is only the transport: a map of rooms, each with its set of connections, plus size and rate limits, a room cap and TTL pruning.
- `shared.js` loads the shared modules from the repo root.
- Everything else, including joins, resumes, moves, draws, options and per-viewer redaction, lives in `../shared/room-session.js` and `../shared/room-logic.js`. The Cloudflare Worker uses the same code.

Protocol: `../multiplayer-schema.md`.
