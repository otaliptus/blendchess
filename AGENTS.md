Build/Lint/Test: frontend has no build step; open `index.html` directly or run `python3 -m http.server 8080`.
Build/Lint/Test: frontend has no automated lint/test commands.
Build/Lint/Test: Node multiplayer server lives in `server/`; run `npm start`, tests via `npm test`.
Build/Lint/Test: Cloudflare worker lives in `ws-worker/`; run `npm run dev` or `npm run deploy`.
Architecture: browser client is static (`index.html`, `style.css`, `app.js`) and uses `chess-core.js` for rules.
Architecture: `app.js` is an IIFE that manages UI state, rendering, local mode, and online websocket session flow.
Architecture: shared rule engine is `chess-core.js` (board creation, move generation, legality, SAN, terminal checks).
Architecture: client-side state validation helpers are in `client/stateGuards.js`.
Architecture: two multiplayer backends exist: Node server (`server/server.js`) and Cloudflare Worker+DO (`ws-worker/src/*`).
Architecture: Worker currently routes all sessions to one Durable Object hub (`global-hub`).
Architecture docs: project overview in `README.md`, system details in `ARCHITECTURE.md`, behavior boundaries in `GAMEPLAY_EXPECTATIONS.md`.
Important DOM IDs: `board`, `status`, `modeText`, `captures`, `events`, `moveBody`, `checkAlert`, `flashBanner`, `illegalOverlay`, `exportPgn`, `hardMode`, `newGame`, `playMode`, `serverUrl`, `connectServer`, `createRoom`, `joinRoomCode`, `joinRoom`, `spectateRoom`, `copyRoomCode`, `leaveRoom`, `claimDraw`, `resign`, `setupHint`.
Game data: board is 8x8 array of piece objects `{ type, color, hasMoved }`.
Moves: `generateLegalMoves`, `applyMove`, `moveToSAN`, `evaluateTerminalState` are core move/rules helpers.
Rules: king capture is disallowed; missing king states are terminal (`kingCaptured`) as a safety fallback.
Hard mode: if a player is in check and sends an illegal move, the move is rejected and the turn is forfeited (`illegalForfeit`).
Rendering: `renderBoard`, `renderEvents`, `renderMoves`, `renderStatus` update UI from canonical `state`.
Online hydration: stale snapshot versions are rejected via `shouldHydrateSnapshotVersion` for both local and online hydration paths.
History safety: saved snapshots are validated/cloned via `normalizeHistorySnapshot`.
UX behavior: PGN export is available only after game over; spectator header shows count (`Spectators: N`) instead of listing names.
Protocol: message types and error codes are in `server/protocol.js` and mirrored in client/worker.
Code style: vanilla ES2015+, no frameworks, no bundler.
Code style: use `const` by default, `let` only when reassigned.
Code style: prefer small pure helpers over inline branching.
Code style: camelCase for variables/functions, UPPER_SNAKE for constants.
Formatting: 2-space indentation, semicolons, trailing commas for multiline literals.
DOM: query once at top-level and reuse cached references.
State: clone board before analysis and before snapshot export; avoid mutating shared references.
Error handling: guard invalid states early; return `null`/`false` or protocol errors instead of throwing.
Comments: add only when chess rules or protocol behavior is non-obvious.
External rules: none found (.cursor, CLAUDE, Windsurf, Cline, Goose, Copilot).
