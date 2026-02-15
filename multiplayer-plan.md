# Multiplayer Architecture Plan (Current + Next)

## Current implemented architecture

### Shared rules layer

- `chess-core.js` is the single rules engine used by browser, Node server, and Worker.
- It owns legal move generation, apply logic, SAN, draw checks, and terminal-state evaluation.
- King capture is blocked by rule validation; missing-king states are handled as a terminal fallback.

### Browser client

- `index.html` + `style.css` + `app.js` drive local and online gameplay.
- `client/stateGuards.js` enforces snapshot shape checks and monotonic version hydration.
- Online client treats backend snapshots as authoritative state.

### Node authoritative server (`server/`)

- `server/server.js` handles websocket connections and protocol envelopes.
- `server/roomManager.js` owns per-room authority including seat assignment/reconnect tokens, move validation/application, draw claims, resign, new game, and hard mode handling.
- Illegal move attempts are rejected without mutating board.
- Hard mode supports turn forfeit when illegal move is made while in check.

### Cloudflare Worker path (`ws-worker/`)

- `ws-worker/src/index.js` handles websocket upgrades and routes to Durable Object.
- `ws-worker/src/room.js` mirrors room authority behavior.
- Current routing sends all rooms to one DO instance (`global-hub`).

### Current coverage

- `server/tests/roomManager.test.mjs` covers room and hard-mode behavior.
- `server/tests/stateGuards.test.mjs` covers stale hydration and malformed snapshot guards.

## Known constraints

1. Worker path has a single DO hotspot (`global-hub`).
2. Full websocket integration coverage is limited.
3. Reconnect-state UX still has room for clearer user feedback.

## Short-term plan (low risk, low cost)

1. Expand integration tests:
- create/join/move/illegal/reconnect flow.
- spectator and room lifecycle transitions.
2. Harden worker path:
- apply explicit abuse limits and telemetry.
- keep parity checks against Node behavior.
3. Improve reconnect/waiting states in UI:
- clearer waiting indicators and reconnect banners.

## Scale-oriented plan

1. Route rooms by `roomCode` to room-sharded Durable Objects.
2. Add DO websocket hibernation-friendly flow.
3. Optimize persistence cadence (checkpointing).
4. Add room/IP throttles and spectator caps for graceful degradation.
