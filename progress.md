Original prompt: Do the smoke pass test please

- Initialized smoke-test tracking.
- Verified npx exists.
- Found direct web_game_playwright_client invocation fails because `playwright` package is not locally installed.
- Next: run smoke with Playwright via npx package wrapper and collect screenshots + console output.

- Smoke test run completed via Playwright with inline HTML and mocked WebSocket (environment blocked direct localhost/file navigation in playwright-cli).
- Verified:
  - Local startup hint appears.
  - PGN export is disabled before game end.
  - Online mode setup hint transitions to "Step 1: Click Connect."
  - Connect flow transitions to "Step 2: Create a room..."
  - Create room flow updates room badge to `ABC123`, setup hint to ready/waiting text, and fills join code input.
  - `create_room` websocket intent is sent.
- Artifact: `/tmp/blendchess-smoke/smoke-pass.png`.
- Additional finding: local Node server currently fails startup with `Identifier 'connectionMeta' has already been declared` in `server/server.js`.

- Investigated multiplayer visibility leak during check states.
- Updated `app.js` check-square highlight gating: in online rooms, checked-king square now highlights only for the checked player (or spectator/replay/revealed states), preventing attacker-side position leakage.
- Installed `playwright` under `~/.codex/skills/develop-web-game/` to run the mandated web-game Playwright client.
- Ran smoke render pass with:
  `node --experimental-default-type=module $WEB_GAME_CLIENT --url http://127.0.0.1:8080 --actions-file $WEB_GAME_ACTIONS --iterations 1 --pause-ms 250 --screenshot-dir /tmp/blendchess-check-leak`
- Verified screenshot artifact exists (`/tmp/blendchess-check-leak/shot-0.png`) and basic board/UI render remains intact; no Playwright-captured console error artifact was generated.
- Changed hard-mode rule: illegal move while in check no longer forfeits game/turn; move is rejected and defender keeps turn.
- Updated local client hard-mode copy and local illegal-move handling in `app.js`.
- Updated Node backend (`server/roomManager.js`) and Worker backend (`ws-worker/src/room.js`) for authoritative parity.
- Updated behavior docs (`GAMEPLAY_EXPECTATIONS.md`, `ARCHITECTURE.md`, `server/README.md`, `ws-worker/README.md`, `multiplayer-schema.md`).
- Added Node backend test: `hard mode rejects illegal move without forfeit when mover is in check`.
- Verification: `node --check app.js`, `node --check server/roomManager.js`, `node --check ws-worker/src/room.js`, `npm test` in `server/`, plus Playwright smoke screenshot `/tmp/blendchess-hardmode-check/shot-0.png`.
