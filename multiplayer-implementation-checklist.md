# Multiplayer Implementation Checklist

## Phase 0: Foundation

- [ ] Define room lifecycle and IDs.
  - Add `/server/package.json` and install dependencies.
  - Add `/server/server.js` and `/server/protocol.js`.
- [ ] Add README for run instructions.
- [ ] Add `client` and `server` folders.

## Phase 1: Rules and Engine Unification

- [ ] Extract pure logic into `chess-core.js`.
  - Keep existing behavior parity.
  - Add unit-like assertion scripts (manual console smoke tests if no test framework).
- [ ] Add `server/chessEngineFacade.js`.
- [ ] Ensure all legal move checks include king safety, castling, en passant, promotion variants.

## Phase 2: Authoritative Match Room

- [ ] Implement `server/roomManager.js`.
  - create/join/leave flow.
  - board state per room.
  - move history and counters.
- [ ] Implement message handling in `server/server.js`.
- [ ] Send snapshots on connect/rejoin.

## Phase 3: Client Transport

- [ ] Add `client/network.js` with reconnect + heartbeat.
- [ ] Add `client/multiplayer.js` session controller.
- [ ] Add lobby and status UI in `index.html` and `style.css`.

## Phase 4: UI Refactor

- [ ] Split render logic from game logic:
  - Add `render-sync.js` for board/side panel sync.
  - Add `move-log-sync.js` for SAN event list rendering from authoritative payloads.
- [ ] Update `app.js`:
  - remove direct move apply flow.
  - forward legal intents through `client/network.js` only.
  - preserve blind mode piece visibility model.

## Phase 5: Game Flow

- [ ] Add `claim_draw` and `resign` from client to server.
- [ ] Add claim/result modal/status updates.
- [ ] Enforce turn ownership and prevent invalid UI clicks.

## Phase 6: Reliability and Feedback

- [ ] Add `ping/pong` heartbeat and stale connection handling.
- [ ] Add reconnect behavior with last-known board version.
- [ ] Add visible error banners.

## Phase 7: Playtest & hardening

- [ ] Two-device smoke tests.
- [ ] Test castling rights after rook/king movement.
- [ ] Test en passant on both sides.
- [ ] Test underpromotion.
- [ ] Test threefold/50-move draw claim behavior.
- [ ] Test disconnect/refresh mid-game and state resync.
- [ ] Add final polish in `style.css` for lobby and status clarity.

## Acceptance criteria

- Two browser clients can create/join the same room and play a full game.
- The server rejects illegal moves and reports reason.
- Both clients always converge to identical board and move log.
- Draw/checkmate/stalemate outcomes are consistent across both clients.
- Current local single-player remains functional as fallback mode.

