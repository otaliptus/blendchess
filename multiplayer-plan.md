# Multiplayer Architecture Plan (Current + Next)

## Current implemented architecture

### Shared rules layer
- `chess-core.js` is the single rule engine used by browser, Node server, and Worker.
- It owns move generation, legality checks, SAN formatting, draw checks, and terminal evaluation.

### Browser client
- `index.html` + `style.css` + `app.js` render and drive local and online modes.
- `client/stateGuards.js` validates history snapshots and hydration version monotonicity.
- Client is view/input-first in online mode and applies authoritative snapshots from backend.

### Node authoritative server (`server/`)
- `server/server.js` hosts WebSocket transport and room lifecycle.
- `server/roomManager.js` is the per-room state authority:
  - seat assignment and reconnect/resume token handling,
  - move validation/application via `chessEngineFacade`,
  - draw claim, resign, hard mode, new game, and snapshots.
- `server/protocol.js` centralizes message and error enums.
- Basic abuse controls are present:
  - max payload size,
  - per-connection message rate limiting.

### Cloudflare Worker path (`ws-worker/`)
- `ws-worker/src/index.js` upgrades WebSockets and forwards to Durable Object `GAME_HUB`.
- `ws-worker/src/room.js` currently stores all rooms in one Durable Object instance (`global-hub`).
- State is persisted through Durable Object storage.

### Test coverage
- `server/tests/roomManager.test.mjs` covers key room/draw/hard-mode/seat-cleanup behavior.
- `server/tests/stateGuards.test.mjs` covers stale hydration and snapshot validation helpers.

---

## Known constraints right now

1. Worker topology is single-hub (`global-hub`), so all rooms share one DO bottleneck.
2. Worker websocket handling uses `server.accept()` style flow, not hibernation-oriented optimization.
3. Browser onboarding for create/join room flow is functional but still high-friction.
4. Replay smoke/integration tests are still light.

---

## Short-term plan (low risk, low cost)

1. Improve UX flow:
- simplify connect/create/join path,
- better waiting-room signals,
- clearer turn/check feedback and room-state messaging.

2. Improve reliability tests:
- protocol-level integration flow (create/join/reconnect/move/invalid move),
- room lifecycle tests (stale seat cleanup, spectator transitions),
- client-state guard tests for malformed persistence payloads.

3. Harden Worker path:
- mirror rate-limit + payload limits from Node server,
- improve error telemetry for room-level failures.

---

## Scale-oriented plan

1. Replace single-hub Worker routing with room-keyed sharding:
- route by `roomCode` (`idFromName(roomCode)`), not `global-hub`.

2. Adopt hibernation-friendly websocket patterns in Durable Objects.

3. Tune persistence strategy:
- checkpoint snapshots at defined intervals or key events,
- avoid coarse whole-map writes per operation.

4. Add policy controls:
- room-level and IP-level request throttles,
- spectator caps and safe degradation path under load.

This keeps operational costs low while removing current hotspot limits.
