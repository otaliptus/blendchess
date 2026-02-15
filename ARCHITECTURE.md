# Blendchess Architecture

## 1) High-level components

- Frontend UI: `index.html`, `style.css`, `app.js`
- Shared rules engine: `chess-core.js`
- Client validation helpers: `client/stateGuards.js`
- Node backend: `server/`
- Cloudflare Worker backend: `ws-worker/`

The rules engine is shared so move legality and terminal evaluation stay consistent.

## 2) Frontend flow

`app.js` manages:

- mode selection (Local vs Online Friend),
- board rendering and status updates,
- input handling (select/move/promotion),
- websocket session lifecycle for online mode.

Main render responsibilities:

- `renderBoard`
- `renderStatus`
- `renderMoves`
- `renderEvents`

Frontend treats backend `game_state` as canonical in online mode.

## 3) Rules layer flow (`chess-core.js`)

Core helper flow per move:

1. Generate legal moves.
2. Validate selected move.
3. Apply move to cloned board state.
4. Compute SAN and captures.
5. Evaluate terminal state (checkmate, stalemate, draw, fallback king-captured).

Important safety rules:

- King capture is not a legal move.
- Missing king positions are handled as terminal fallback to prevent undefined behavior.

## 4) Local mode flow

1. Frontend computes legal moves directly with `chess-core.js`.
2. Frontend applies move and updates local state.
3. History/event UI updates from local canonical state.
4. No network/backend dependency.

## 5) Online mode flow

1. Client opens websocket to Node or Worker backend.
2. Player creates or joins room.
3. Backend assigns seat (`w`/`b`) or spectator role.
4. Client sends move intent.
5. Backend validates move authoritatively.
6. Backend broadcasts authoritative `game_state`.
7. Clients hydrate only if snapshot version is monotonic.

Hard mode behavior:

- Illegal move attempts are rejected.
- If player is in check and submits illegal move, turn can be forfeited (`illegalForfeit`).

## 6) Session and room model

- Two player seats max per room.
- Additional users can join as spectators.
- Reconnect is token-based for player sessions.
- Node backend stores room state in memory with TTL pruning.
- Worker backend persists room state via Durable Object storage.

## 7) Backend paths

### Node (`server/`)

- `server/server.js`: websocket transport + protocol dispatch.
- `server/roomManager.js`: room authority and game-state lifecycle.
- `server/protocol.js`: protocol constants and error codes.

### Cloudflare Worker (`ws-worker/`)

- `src/index.js`: websocket upgrade and DO routing.
- `src/room.js`: Durable Object room authority.

Current Worker topology:

- All sessions currently route to one DO (`global-hub`).
- This is simple but not ideal for high scale.

## 8) Reliability guards

- Client-side stale snapshot rejection.
- Snapshot shape validation for persisted history.
- Backend rate-limit and max-message checks.
- Protocol version mismatch rejection.

## 9) Scaling direction

Recommended next architecture step:

1. Replace single `global-hub` with room-code sharded Durable Objects.
2. Add stronger abuse controls and telemetry.
3. Add integration tests for websocket end-to-end flows.
