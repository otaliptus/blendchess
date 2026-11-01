# Blendchess architecture

## Components

| Path | Role |
| --- | --- |
| `chess-core.js` | Rules engine: move generation, check, terminal states, SAN, plausible moves for the fog |
| `shared/protocol.js` | Message types, error codes, envelope parsing |
| `ws-worker/src/data-version.js` | Checks the release's data version before loading stored state; intentional resets erase storage and retire old sockets |
| `client/dataVersion.js` | Applies a server-announced reset to that server's browser data |
| `shared/engine-facade.js` | Validates a move intent against the legal moves |
| `shared/room-logic.js` | Room and game authority, **per-viewer redaction** (`createView`), clocks, reserved seats, PGN |
| `shared/room-session.js` | Message handling for one room, written against a tiny transport interface |
| `shared/rating.js` | Elo maths |
| `shared/lobby-logic.js` | Controls, queue matching, identity records, in-memory store |
| `shared/lobby-session.js` | Lobby messages, sessions, the live-games list and result reporting, transport-agnostic |
| `shared/account-api.js` | The HTTP API: passkeys, account keys, device sessions, profiles, game records, live games, leaderboard |
| `server/` | Node transport (`ws`), in-memory rooms and lobby |
| `ws-worker/` | Cloudflare Worker transport: one Durable Object per room, one global `LobbyHub` |
| `index.html`, `style.css`, `app.js`, `client/` | Static pixel-art client |

The shared modules are plain classic scripts that publish themselves on `globalThis` and also set
`module.exports`. The browser loads them with `<script>` tags, Node with `require`, and Wrangler bundles
them as side-effect imports. Load order: `chess-core.js` -> `protocol.js` -> `engine-facade.js` ->
`room-logic.js` -> `room-session.js` -> `rating.js` -> `lobby-logic.js` -> `lobby-session.js` -> `account-api.js`.
The browser only loads the first four: the lobby and accounts live on the server.

## Hidden information lives on the server

Earlier versions broadcast the whole game and masked it in the browser. Now the room keeps the full
state and `createView(state, viewer)` builds what each member may know (see the table in
`multiplayer-schema.md`). Because the masking happens on the server, opening dev tools shows nothing a
player shouldn't see. The fog only lifts when the game is over, for spectators of a private room when
the host enabled party mode, and for anyone watching a lobby game.

What is public, Kriegspiel style: that a move happened, captures and their squares, that an illegal try
happened, forfeits, draw offers, resignations. Check goes only to the side in check, along with the
lines it comes from.

Lobby games are open to watchers, and every watcher sees the whole board (`spectatorView: 'open'` is
fixed at reservation): players are trusted. `spectatorPerspective(state, ipHash)` in `room-logic.js` is
a switched-off option that would limit a watcher on a player's network to that player's view; its
call sites are commented out, so no player networks are collected.

"One network" everywhere (same-network practice games, every per-network limit) is
`networkKey(address)`: an IPv4 address, or an IPv6 /64, since devices on one IPv6 network each have
their own (often rotating) address but share the prefix. Loopback is `unknown` and never matches.

The client can't run `generateLegalMoves` any more, since it doesn't know where the enemy is. Instead it uses
`generatePlausibleMovesForPiece`, which only respects your own pieces. It powers the move hints and stops
moves that are impossible on any board, so a misclick never costs a hard-mode turn. The server has
the final word on everything else.

## One session layer, two transports

`shared/room-session.js` handles create/join/resume/spectate, moves, options, draws, resignations, new
games and disconnects. It talks to the transport only through:

```js
hooks = { connections(), send(conn, msg), close(conn, code, reason), save(conn), makeResumeToken() }
```

- **Node** (`server/server.js`): a `Map` of rooms, each with a `Set` of connections. Rate and size limits, room cap, TTL pruning.
- **Worker** (`ws-worker/src`): `index.js` routes `?room=CODE` to `idFromName(CODE)` and `?create=1` to a fresh random code (retrying on a 409 collision). `room.js` uses the WebSocket hibernation API. Per-socket metadata lives in socket attachments; the room is a single small storage value per Durable Object. After an eviction, presence is rebuilt from the sockets that are still open. An alarm deletes rooms that have sat idle for an hour.

## Ranked lobby

`LobbyHub` is a single Durable Object (Node: an in-process store) that owns identity, the queue,
ratings, finished-game records and the live list. It never holds a game.

- **Sessions.** First contact mints a guest player and a 256-bit session token for that browser. Only
  the token's SHA-256 is stored, as `token:<hash>` -> player id (the key identities used before
  accounts, so those are sessions too), and the player record lists its session hashes (at most 20),
  so one device can be signed out, or all the others.
- **Seats belong to sessions.** When the lobby makes a match, each seat is bound to the session of the
  socket that receives the match (server-side only), and the player record remembers its last five
  lobby rooms with their sessions.
  Signing a session out sends those rooms an internal `POST /revoke`: the seat's ticket and resume
  token stop working and its game sockets close with code `4001`. The Worker stores each revocation
  before sending it and clears it only when the room acknowledges; the lobby alarm retries the rest
  every 15 seconds for up to a day. Each retry has a fixed stored time, and scheduling never pushes
  back an alarm that is already due sooner, so steady lobby traffic cannot postpone retries (or the
  matchmaking tick).
- **Securing an account.** A player can add passkeys (WebAuthn, discoverable credentials, verified with
  `@simplewebauthn/server`; `cred:<id>` holds the public key, counter and RP ID) and one account key
  (120 bits of Crockford base32, stored as `key:<sha256>`; high entropy means no slow hash is needed).
  Either makes the account *secured*, which is what puts it on the leaderboard. Passkeys are enabled
  on the production Pages hostname as well as the custom domain; each has its own RP ID. Account keys
  let a player carry their account between them and register a passkey on the destination. The RP ID is the page's
  host without `www.`, so `blendchess.com` and `www.blendchess.com` share passkeys. Challenges are
  stored (the object may hibernate during the prompt), single use, tied to the origin that asked for
  them, and expire after five minutes; their ids start with the expiry so expired ones are swept in
  order.
- **Queue.** Entries live in storage (Worker) or memory (Node) and carry the socket id, so an eviction
  drops players whose sockets are gone. Matching pairs the closest ratings within a window that widens
  with wait time; controls never mix; immediate rematches are suppressed.
- **Rooms.** The lobby picks a room code, generates two tickets, and asks the `GameHub` for that code to
  `POST /reserve` with both seats. The room stores the tickets (server-side only) and accepts a seat
  only from the matching ticket. This is the only way a lobby room is created, and its `/reserve` path
  is internal: `index.js` never forwards it from the internet.
- **Live list.** Every lobby game in progress (ranked or same-network practice) is on the `live` list
  from the moment it is matched; a rematch puts the room back on it, and the result report or a release
  takes it off. Entries expire after two hours regardless.
- **Results and records.** When a lobby game ends, the room calls the lobby's internal `/report` once,
  with an idempotency key of `roomCode:gameId`, the result and the compact move list
  (`[from, to, san, promotion, capture, forfeit]` per ply). A ranked game must match both players'
  active-game markers; a practice game must match the live entry. The lobby then updates ratings (ranked
  only), stores the game as `game:<id>`, prepends a one-line summary of it to both players' `recent`
  list (the 20 a profile shows, so a profile is one read) and returns `{ updates, gameId }`. The room marks the game `reported` only then, and a rematch waits for
  it, so one game's result can never land on the next. The room re-broadcasts its views with the
  rating changes and `recordId`. A rejection the lobby marks `final` is not retried; other failures
  are retried by the room alarm. A room that dies before the game starts releases both players without
  a rating change.
- **HTTP API.** `index.js` forwards `/api/*` to the lobby (`/leaderboard` is an alias). Both servers
  hand the raw request to `accountApi.handleHttp`, and `accountApi.routeOf` is the single place that
  maps a URL to a route, its query and its edge-cache key. Public reads (`/api/leaderboard`,
  `/api/live`, `/api/players/:name`, `/api/games/:id`) answer any origin and are cached at the edge for
  a few seconds (game records for a day) once the Worker runs on a custom domain; only the parameters
  a route reads make up the cache key. Account routes (`/api/me`,
  `/api/auth/*`) take a bearer session token, answer only the site's own origins (`SITE_ORIGINS`, plus
  `localhost`), and are rate limited per network, with a tighter limit on failed sign-ins.
- **Watching a full room.** Live room codes are public, so watchers or idle sockets could fill a room's
  64 connections. A connection opened with `seat=1` (the client sends it when it holds a ticket or a
  resume token) closes an idle socket, or failing that the newest watcher, to make room; it still has to
  present a valid ticket or token to sit down.
- **Abuse limits.** Ranked rooms have clocks and fixed options. Queue length, queue entries per network,
  sockets per network, new identities per network per hour, room creation per network per minute (plus
  a global cap), API requests and message size and rate are all bounded. Two accounts on the same
  network are matched into an unrated practice game.

## Game rules worth knowing

- `boardVersion` is monotonic for the life of a room, so clients can always drop stale snapshots, including after a rematch.
- Forfeited turns are recorded as plies (`--`), so colours always alternate in the move list, replay and PGN.
- A forfeit clears the en passant square.
- Options (hard mode, party mode) are locked between the first move and the end of the game, and for good in lobby-arranged games.
- A lobby game's clock is authoritative (ranked and practice alike): time is charged on the server, each played move earns the increment, and a flag fall (or a no-show for two minutes) ends the game and is reported like any other result.
- `new_game` is refused while a game is in progress; after a finished game the players swap colours.
- Automatic draws: stalemate, fivefold repetition, the 75-move rule, and dead positions (K v K, a single minor piece, or same-coloured bishops only). Threefold and the 50-move rule must be claimed.

## Client

`app.js` renders views; it never decides legality or ratings. Local pass-and-play runs the same
`room-logic.js` in the browser and switches the board to the side to move after each turn. A turn banner
above the board says whose move it is and summarizes what the opponent did. The ranked panel talks to
`?lobby=1`, shows a live clock from the server's remaining time plus local elapsed time, and reads the
leaderboard, live list and profiles over HTTP. The account panel runs the passkey ceremonies with the
browser's WebAuthn API (offered only on `blendchess.com` and `localhost`, where a passkey will keep
working) and shows a new account key once. Links: `?p=name` opens a profile, `?game=id` a replay,
`?watch=CODE` a live game. The sign-in token is stored per server URL, so a link that points the
client at another server (`?ws=`) never sends it the main server's token.
Supporting modules:

- `client/sprites.js`: 16x16 pixel pieces and the umpire, drawn to canvas once and cached as data URLs.
- `client/sfx.js`: a small WebAudio chiptune synth (effects plus optional music).
- `client/fx.js`: particles, screen shake, banners and typewriter text. All of it respects `prefers-reduced-motion`.
- `client/stateGuards.js`: snapshot version checks.
- `assets/help/*.gif`: the how-to-play animations, rendered from the same sprites by `tools/make-help-gifs.mjs` (`cd tools && npm install && npm run help-gifs`).

## Tests

- `server/tests`: engine perft suite, room logic, rated rooms and watching, ratings, lobby logic and session (fake transport), accounts and the HTTP API (with a stand-in authenticator), Node end-to-end over real sockets and HTTP (rooms, the ranked lobby, accounts).
- `ws-worker/tests`: both Durable Objects against a mocked hibernation API and storage.
- The end-to-end suite also runs against `wrangler dev`: `E2E_URL=ws://127.0.0.1:8787 node --test tests/server-e2e.test.mjs`.
