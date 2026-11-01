# Blendchess Cloudflare Worker

Worker + Durable Object backend for online games. Every room is its own Durable Object.

## Files

- `src/index.js`: routes `?room=CODE` to `idFromName(CODE)`; `?create=1` picks a fresh code (retries on a collision, after a per-network rate check); `?lobby=1` to the global lobby. `GET /leaderboard` reads the lobby.
- `src/room.js`: the `GameHub` Durable Object (one instance per room) on the WebSocket hibernation API. It also accepts an internal `POST /reserve` from the lobby for ranked rooms.
- `src/lobby.js`: the `LobbyHub` Durable Object: identities, queue, matchmaking, Elo and the leaderboard board.
- `wrangler.jsonc`: bindings `GAME_HUB` -> `GameHub` and `LOBBY_HUB` -> `LobbyHub`, migrations `v1` and `v2` (SQLite-backed).

Game and lobby logic are shared with the Node server (`../shared/room-*.js`, `../shared/lobby-*.js`,
`../shared/rating.js`).

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
- A room alarm wakes for the earliest of: the clock deadline, a missing opponent (2 minutes), a failed result report (retried every 15 s), and idle cleanup (an hour with nobody connected). Idle rooms are deleted; a dead ranked room releases both players from the lobby.
- Limits: 16 KiB per message, 40 messages per second per socket, 64 sockets per room and 4 per network.
- The lobby caps sockets (6 per network), queue entries (500 total, 6 per network), new identities (10 per network per hour, widen with `--var NEW_PLAYER_LIMIT:100` on a dev deployment only), room creation (12 per network per minute plus a global cap) and message rate.
- Tickets and the room reservation are server-side only: `index.js` never forwards `/reserve`, `/report`, `/active`, `/release` or `/limit/create` from the internet.
- The old single `global-hub` instance is no longer used. Its stored state is orphaned and harmless.
