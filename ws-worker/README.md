# Blendchess Cloudflare Worker

Worker + Durable Object backend for online games. Every room is its own Durable Object.

## Files

- `src/index.js`: routes `?room=CODE` to `idFromName(CODE)`; `?create=1` picks a fresh code (retries on a collision, after a per-network rate check); `?lobby=1` to the global lobby. `/api/*` (and the old `/leaderboard`) goes to the lobby, with CORS preflight answered here and public reads put in the edge cache.
- `src/room.js`: the `GameHub` Durable Object (one instance per room) on the WebSocket hibernation API. It also accepts an internal `POST /reserve` from the lobby for ranked rooms.
- `src/lobby.js`: the `LobbyHub` Durable Object: sessions, passkeys, account keys, queue, matchmaking, Elo, game records, the live list and the leaderboard. Passkeys are verified with `@simplewebauthn/server`.
- `wrangler.jsonc`: bindings `GAME_HUB` -> `GameHub` and `LOBBY_HUB` -> `LobbyHub`, migrations `v1` and `v2` (SQLite-backed), and the `SITE_ORIGINS` variable (sites allowed to use the account routes; `localhost` is always allowed).

Game and lobby logic are shared with the Node server (`../shared/room-*.js`, `../shared/lobby-*.js`,
`../shared/account-api.js`, `../shared/rating.js`). Everything runs on the free Workers plan: SQLite-backed
Durable Objects, no KV, D1 or paid features.

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

### On a custom domain

1. Add the domain to Cloudflare and attach it to the Pages project (`blendchess.com` and `www.blendchess.com`).
2. Keep `https://blendchess.com` and `https://www.blendchess.com` in `SITE_ORIGINS` (they are already there).
3. Optional: give the Worker a route on the domain, e.g. `api.blendchess.com` as a Custom Domain, and point
   `DEFAULT_SERVER_URL` in `app.js` at `wss://api.blendchess.com`. The edge cache for public reads only works
   on a custom domain; on `workers.dev` every read reaches the lobby.
4. Send `blendchess.pages.dev` visitors to `blendchess.com` (a Bulk Redirect rule). Browser storage is per
   domain, so guests on the old address keep their account only if they secure it first; passkeys are only
   offered on `blendchess.com` for the same reason.

## Notes

- Per-socket state lives in socket attachments and the room in Durable Object storage, so hibernation and evictions don't lose games. Presence is rebuilt from the open sockets.
- A room alarm wakes for the earliest of: the clock deadline, a missing opponent (2 minutes), a failed result report (retried every 15 s), and idle cleanup (an hour with nobody connected). Idle rooms are deleted; a dead ranked room releases both players from the lobby.
- Limits: 16 KiB per message, 40 messages per second per socket, 64 sockets per room and 4 per network (an IPv4 address or an IPv6 /64). In a full room, a connection marked `seat=1` closes an idle socket or the newest watcher so a player can always get back to a seat.
- The lobby caps sockets (6 per network), queue entries (500 total, 6 per network), new identities (10 per network per hour, widen with `--var NEW_PLAYER_LIMIT:100` on a dev deployment only), room creation (12 per network per minute plus a global cap) and message rate.
- Tickets and the room reservation are server-side only: `index.js` never forwards `/reserve`, `/report`, `/active`, `/release` or `/limit/create` from the internet. From outside, the lobby is reachable only through `?lobby=1` and `/api/*`.
- A daily lobby alarm prunes week-old report markers. Passkey challenges are kept in memory for five minutes, never in storage.
- The old single `global-hub` instance is no longer used. Its stored state is orphaned and harmless.
