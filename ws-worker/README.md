# Blendchess Cloudflare Worker

Worker + Durable Object backend for online games. Every room is its own Durable Object.

## Files

- `src/index.js`: routes `?room=CODE` to `idFromName(CODE)`; `?create=1` picks a fresh code (retries on a collision).
- `src/room.js`: the `GameHub` Durable Object (one instance per room) on the WebSocket hibernation API.
- `wrangler.jsonc`: binding `GAME_HUB` -> `GameHub` (SQLite-backed).

Game logic is shared with the Node server (`../shared/room-session.js`, `../shared/room-logic.js`).

## Run and test

```bash
npm install
npm run dev     # local workerd
npm test        # unit tests against a mocked hibernation API
```

End-to-end against `wrangler dev`: see `../server/README.md` (`E2E_URL`).

## Deploy

```bash
npx wrangler login
npx wrangler deploy
```

URL format: `https://<worker>.workers.dev` -> `wss://<worker>.workers.dev`. Health check: `GET /health`.

## Notes

- Per-socket state lives in socket attachments and the room in Durable Object storage, so hibernation and evictions don't lose games. Presence is rebuilt from the open sockets.
- An alarm deletes a room after an hour with nobody connected.
- Limits: 16 KiB per message, 40 messages per second per socket, 64 sockets per room.
- The old single `global-hub` instance is no longer used. Its stored state is orphaned and harmless.
