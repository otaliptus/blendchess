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

Runs the engine perft suite, room logic, rated rooms, Elo and matchmaking, session handling against a
fake transport, and end-to-end suites that spawn this server and play games over real sockets (private
rooms, and the full ranked flow from queue to rating to leaderboard). Point `E2E_URL` at another server
(e.g. `wrangler dev`) to run the end-to-end suites there instead.

## How it fits together

- `server.js` is only the transport: a map of rooms, each with its set of connections, plus size and rate limits, a room cap and TTL pruning. It also hosts the ranked lobby (`?lobby=1`) with an in-memory store and serves `GET /leaderboard`.
- Ranked rooms report results to the lobby once per game; clocks, no-show deadlines and the report retry run on a 500 ms ticker.
- `shared.js` loads the shared modules from the repo root.
- Everything else, including joins, resumes, moves, draws, options and per-viewer redaction, lives in `../shared/room-session.js` and `../shared/room-logic.js`. The Cloudflare Worker uses the same code.

Protocol: `../multiplayer-schema.md`.
