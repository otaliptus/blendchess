# Multiplayer Implementation Plan

## Objective
Build a real-time, two-player online mode for the existing blind/regular chess board while preserving the current single-player local experience.

The implementation keeps the rule engine single-source-of-truth and places networking in a small server authority layer. The server validates all moves and owns final game state; clients are view+input proxies.

---

## What to Remove

- **Client-driven final legality enforcement**
  - Remove the current pattern where `app.js` directly applies every move as final truth.
  - Replace direct board mutation-from-click with move requests to the host/server.

- **Hard-coded local-only flow**
  - Remove fixed implicit white-first assumptions from UI startup (`state.turn` from local board only).
  - Replace with session-assigned colors from room join/host handshake.

- **Any direct cross-session assumptions**
  - Remove any code that assumes both users share the same runtime (`captured` display, events, move history) and make those values sync-driven.

---

## What to Add

### 1) Server layer (authoritative)

1. Add `server/package.json`
   - Node runtime metadata and dependencies (`ws`, optional `nanoid` for room ids).
   - Scripts:
     - `start: node server.js`

2. Add `server/server.js`
   - Create WebSocket server.
   - Route messages by room.
   - Validate room code lifecycle:
     - create room
     - join room
     - leave/disconnect cleanup
     - start/restart game
   - Persist room game state in memory.

3. Add `server/roomManager.js`
   - `createGameState`, `joinPlayer`, `startGame`, `disconnectPlayer`, `applyPlayerMove`.
   - Maintain deterministic state per room:
     - board
     - turn
     - legal move history
     - repetition map
     - half-move/full-move counters
     - result/winner flags
   - Only allow legal moves from correct color and current turn.

4. Add `server/protocol.js`
   - Central message types and payload validators.
   - Keep one place for client-server contract versioning.
   - Message enum examples:
     - `create_room`, `join_room`, `room_created`, `room_joined`, `player_assigned`
     - `game_state`, `move_intent`, `move_rejected`, `move_applied`, `claim_draw`, `draw_result`, `resign`, `error`, `ping/pong`

5. Add `server/README.md`
   - Start command
   - environment variable (`PORT`)
   - expected websocket URL and sample payloads

### 2) Core rule engine extraction (shared pure logic)

1. Add `chess-core.js`
   - Extract pure logic from `app.js`:
     - board creation/cloning
     - move generation
     - legal move filtering
     - check/checkmate/stalemate detection
     - draw checks (threefold, fivefold, 50-move, 75-move, insufficient material)
   - Keep pure functions only, no DOM and no `document` accesses.
   - Export `createInitialState()`, `generateLegalMoves()`, `applyMove()`, `evaluateState()` and helper hash.

2. Add `server/chessEngineFacade.js`
   - Light wrapper for server use:
     - normalize board state before move
     - call pure rules from `chess-core.js`
     - return `{ nextState, outcome, errors }`
   - Ensure castling, promotion, en passant, and check logic remain authoritative here.

3. Add `client/chess-client-adapter.js`
   - Browser-side wrapper for the same API contract used by current UI:
     - convert wire payloads to local render model
     - compute move label strings for log display

### 3) Client networking + room UI

1. Add `client/network.js`
   - `connect(url)`, `send(message)`, `close()`.
   - reconnect loop with jitter + exponential backoff.
   - heartbeat ping/pong.

2. Add `client/multiplayer.js`
   - Session state (`roomCode`, `playerId`, `color`, `ready` flags).
   - Handles incoming server messages and updates UI state model.
   - On local click, convert square selection + target into `move_intent`.
   - Block input when:
     - not joined
     - game not started
     - not your turn
     - gameOver

3. Add `client/multiplayer-ui.js`
   - Lobby panel controls:
     - create room button
     - join room input/button
     - room code display/copy
     - “copy invite link” (optional)
     - player color status
     - connection status text
   - Optional actions:
     - resign
     - request draw
     - claim draw
     - restart same room

4. Add `index-multiplayer.html` or update existing `index.html`
   - Add connection controls and mode switch:
     - `Local (current)` vs `Online multiplayer`.
   - Add script tags for new networking/client modules.
   - Existing board and panel IDs stay unchanged for renderer compatibility where possible.

### 4) Rendering/data-flow split

1. Refactor `app.js`
   - Keep rendering, local event binding, and piece visibility behavior.
   - Remove rule engine internals from click-handler path.
   - Replace move pipeline:
     - local: build candidate move request
     - send to server via `client/network.js`
     - on `game_state/move_applied`, patch UI from authoritative state.

2. Add `render-sync.js`
   - Centralized functions to render from canonical game state snapshots (server-provided).
   - Maintain current blind visibility model and status text composition.

3. Add `move-log-sync.js`
   - Standardize event/move log updates from server-provided history.

### 5) Deployment/run scripts

1. Add root `start.sh` (or equivalent docs-only commands)
   - One command for local static open
   - One command for backend start

2. Add `.gitignore` entries (if not already)
   - lockfile / runtime logs / temporary room state if any

---

## Current-State Compatibility and API Boundary

### Boundary I will enforce
- **Do not trust client state for legality.**
- Client sends: `move_intent` only.
- Server returns:
  - `move_applied` with full board snapshot on success.
  - `move_rejected` with explicit reason on failure.

### Why this approach
- Removes split-brain legality bugs.
- Allows both players to have identical rule outcomes even on latency/disconnect/rejoin.
- Keeps blind mode feel for user with local-only rendering choices.

---

## Detailed File Plan (Add/Change/Remove)

### Add
- `server/package.json`
- `server/server.js`
- `server/roomManager.js`
- `server/protocol.js`
- `server/chessEngineFacade.js`
- `server/README.md`
- `chess-core.js`
- `client/network.js`
- `client/multiplayer.js`
- `client/multiplayer-ui.js`
- `client/chess-client-adapter.js`
- `render-sync.js`
- `move-log-sync.js`

### Change
- `index.html`
  - Add room/lobby UI and include multiplayer scripts conditionally/in parallel to local mode.
- `style.css`
  - Add styles for lobby, invite code, status badges, reconnect states.
- `app.js`
  - Move from local-rule execution to render/input orchestration.
  - Preserve current blind mode defaults.

### Remove
- None immediately removed until extracted flow is stabilized.
- Local-only direct `applyMove` from `app.js` becomes dead unless fallback local/offline mode is explicitly selected.

---

## Risk Areas to Address Early

1. **Draw rule semantics**
   - Keep 75-move and fivefold as automatic.
   - Implement claim flow for 50-move and threefold unless you want strict auto behavior.

2. **State reconciliation**
   - On reconnect, client may have stale board. Server snapshot must be source-of-truth.

3. **Disconnection timing**
   - Decide default policy:
     - pause game with reconnect window
     - or forfeit on long disconnect.

4. **Promotion UX**
   - For online games, avoid modal conflicts when both players act quickly; use server-confirmed choice.

5. **Reordering of events and move clock**
   - All logs should be server-ordered by move id to prevent UI race.

---

## Delivery Sequence (I recommend)

1. Add protocol + engine extraction.
2. Add server room manager and move validation path.
3. Add client networking + lobby.
4. Refactor rendering to consume snapshot states.
5. Replace local move pipeline with network move requests.
6. Add draw-claim flow and disconnect semantics.
7. Manual two-client smoke test, then UI polish.

---

## Validation Checklist Before You hand this to a friend

- create room and join from second device/browser
- both players see same board after random moves
- en passant, castling, promotion function correctly
- illegal move rejection is authoritative
- stalemate/checkmate/stalemate end states are identical on both clients
- disconnect/reconnect does not fork state
- one player can offer/claim draw and both UIs update consistently

