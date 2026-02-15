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
