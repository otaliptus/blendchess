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
4. If redirecting `blendchess.pages.dev` visitors to `blendchess.com`, first let players save an account key.
   Browser storage and passkeys belong to their domain. A Pages passkey will not sign in on the custom
   domain; an account key lets a player sign in there and add a new passkey to the same account.

### Intentional release resets

Ordinary deployments keep data. `DATA_VERSION` in `shared/protocol.js` starts at **1**, which adopts
existing unversioned storage without deleting it. It is separate from the WebSocket protocol version.

For a deliberate **full reset**, increase `DATA_VERSION` to the next integer in a release commit and
deploy both the Worker and Pages through the normal workflow. This is destructive: accounts, passkeys'
server records, account keys, sessions, ratings, histories and active games are erased. Take any desired
backup first. This does not implement a season-only rating reset.

- Each lobby/room checks its stored version before loading data. An increase deletes its storage and
  alarm, records the new version, and closes old sockets with code `4002`. Sleeping objects are erased
  on their next request or alarm, not all at the instant of deployment. Old messages are ignored.
- The lobby is reset when first accessed; private rooms are reset when visited or when their idle alarm
  runs. This is an application reset, not a guarantee that every dormant Cloudflare object has already
  been physically deleted. Retired objects that never wake would need separate administrative cleanup.
- The browser checks `/api/config` on startup and before opening a connection. Once it sees an increase,
  it removes that server's identity and saved room. For the default server it also clears local games
  and its replay archive. Preferences and other servers' accounts remain. Offline browsers clean up
  when they next connect; copies of exported PGNs and passkeys in password managers remain outside
  the app's control. Old keys/passkeys no longer sign in after the server reset.
- Edge and browser cache keys include the data version, so old cached profiles/replays are not reused.
- **Never decrease the version**, including during a code rollback: carry the latest `DATA_VERSION`
  into the rollback commit. An older version refuses to open newer stored data, preventing another wipe.
  Re-deploying the same version preserves accounts and games created after the reset.

No reset is performed by adding this feature or enabling Pages passkeys. To run a future reset, the
release must explicitly change the version number. Node uses memory-only storage and already starts
empty on process restart; it exposes the same configuration endpoint for the browser.

## Notes

- Per-socket state lives in socket attachments and the room in Durable Object storage, so hibernation and evictions don't lose games. Presence is rebuilt from the open sockets.
- A room alarm wakes for the earliest of: the clock deadline, a missing opponent (2 minutes), a failed result report (retried every 15 s), and idle cleanup (an hour with nobody connected). Idle rooms are deleted; a dead ranked room releases both players from the lobby.
- Limits: 16 KiB per message, 40 messages per second per socket, 64 sockets per room and 4 per network (an IPv4 address or an IPv6 /64). In a full room, a connection marked `seat=1` closes an idle socket or the newest watcher so a player can always get back to a seat.
- The lobby caps sockets (6 per network), queue entries (500 total, 6 per network), new identities (10 per network per hour, widen with `--var NEW_PLAYER_LIMIT:100` on a dev deployment only), room creation (12 per network per minute plus a global cap) and message rate.
- Tickets and the room reservation are server-side only: `index.js` never forwards `/reserve`, `/report`, `/active`, `/release` or `/limit/create` from the internet. From outside, the lobby is reachable only through `?lobby=1` and `/api/*`.
- The lobby alarm also retries seat revocations a room has not acknowledged yet (every 15 s, for up to a day), and once a day prunes week-old report markers. Passkey challenges are stored for five minutes (the object may hibernate during the prompt); their ids start with the expiry, and each new one sweeps up to 128 expired ones.
- The old single `global-hub` instance is no longer used. Its stored state is orphaned and harmless.
