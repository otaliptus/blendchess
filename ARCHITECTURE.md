# Blendchess architecture

## Components

| Path | Role |
| --- | --- |
| `chess-core.js` | Rules engine: move generation, check, terminal states, SAN, plausible moves for the fog |
| `shared/protocol.js` | Message types, error codes, envelope parsing |
| `shared/engine-facade.js` | Validates a move intent against the legal moves |
| `shared/room-logic.js` | Room and game authority, **per-viewer redaction** (`createView`), clocks, reserved seats, PGN |
| `shared/room-session.js` | Message handling for one room, written against a tiny transport interface |
| `shared/rating.js` | Elo maths |
| `shared/lobby-logic.js` | Controls, queue matching, identity records, in-memory store |
| `shared/lobby-session.js` | Lobby messages and result reporting, transport-agnostic |
| `server/` | Node transport (`ws`), in-memory rooms and lobby |
| `ws-worker/` | Cloudflare Worker transport: one Durable Object per room, one global `LobbyHub` |
| `index.html`, `style.css`, `app.js`, `client/` | Static pixel-art client |

The shared modules are plain classic scripts that publish themselves on `globalThis` and also set
`module.exports`. The browser loads them with `<script>` tags, Node with `require`, and Wrangler bundles
them as side-effect imports. Load order: `chess-core.js` -> `protocol.js` -> `engine-facade.js` ->
`room-logic.js` -> `room-session.js` -> `rating.js` -> `lobby-logic.js` -> `lobby-session.js`.
The browser only loads the first five: the lobby lives on the server.

## Hidden information lives on the server

Earlier versions broadcast the whole game and masked it in the browser. Now the room keeps the full
state and `createView(state, viewer)` builds what each member may know (see the table in
`multiplayer-schema.md`). Because the masking happens on the server, opening dev tools or a second tab
as a spectator shows nothing a player shouldn't see. The fog only lifts when the game is over, or for
spectators when the host enabled party mode.

What is public, Kriegspiel style: that a move happened, captures and their squares, that an illegal try
happened, forfeits, draw offers, resignations. Check goes only to the side in check, along with the
lines it comes from.

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

`LobbyHub` is a single Durable Object (Node: an in-process store) that owns ranked identity, the queue
and ratings. It never holds a game.

- **Identity.** First contact mints a player id and a 256-bit token. Only the SHA-256 of the token is
  stored. The token is bearer access to that player's rating, so it stays in the browser.
- **Queue.** Entries live in storage (Worker) or memory (Node) and carry the socket id, so an eviction
  drops players whose sockets are gone. Matching pairs the closest ratings within a window that widens
  with wait time; controls never mix; immediate rematches are suppressed.
- **Rooms.** The lobby picks a room code, generates two tickets, and asks the `GameHub` for that code to
  `POST /reserve` with both seats. The room stores the tickets (server-side only) and accepts a seat
  only from the matching ticket. This is the only way a ranked room is created, and its `/reserve` path
  is internal: `index.js` never forwards it from the internet.
- **Results.** When a ranked game ends, the room calls the lobby's internal `/report` once, with an
  idempotency key of `roomCode:gameId`. The lobby checks that both players have an active game record
  for that room and key before touching ratings, then returns the deltas; the room re-broadcasts its
  views with the new ratings attached. Failed reports are retried by the room alarm; a room that dies
  before the game starts releases both players without a rating change.
- **Leaderboard.** `GET /leaderboard` on the Worker (and the Node server) returns the top 100 from a
  small sorted board kept in the lobby's storage, so the endpoint is one small read.
- **Abuse limits.** Ranked rooms have clocks, no spectators and fixed options. Queue length, queue
  entries per network, sockets per network, new identities per network per hour, room creation per
  network per minute (plus a global cap), and message size and rate are all bounded. Two accounts on
  the same network are matched into an unrated practice game.

## Game rules worth knowing

- `boardVersion` is monotonic for the life of a room, so clients can always drop stale snapshots, including after a rematch.
- Forfeited turns are recorded as plies (`--`), so colours always alternate in the move list, replay and PGN.
- A forfeit clears the en passant square.
- Options (hard mode, party mode) are locked between the first move and the end of the game, and for good in lobby-arranged games.
- A ranked game's clock is authoritative: time is charged on the server, each played move earns the increment, and a flag fall (or a no-show for two minutes) ends the game and is reported like any other result.
- `new_game` is refused while a game is in progress; after a finished game the players swap colours.
- Automatic draws: stalemate, fivefold repetition, the 75-move rule, and dead positions (K v K, a single minor piece, or same-coloured bishops only). Threefold and the 50-move rule must be claimed.

## Client

`app.js` renders views; it never decides legality or ratings. Local pass-and-play runs the same
`room-logic.js` in the browser and switches the board to the side to move after each turn. A turn banner
above the board says whose move it is and summarizes what the opponent did. The ranked panel talks to
`?lobby=1`, shows a live clock from the server's remaining time plus local elapsed time, and fetches the
leaderboard over HTTP.
Supporting modules:

- `client/sprites.js`: 16x16 pixel pieces and the umpire, drawn to canvas once and cached as data URLs.
- `client/sfx.js`: a small WebAudio chiptune synth (effects plus optional music).
- `client/fx.js`: particles, screen shake, banners and typewriter text. All of it respects `prefers-reduced-motion`.
- `client/stateGuards.js`: snapshot version checks.
- `assets/help/*.gif`: the how-to-play animations, rendered from the same sprites by `tools/make-help-gifs.mjs` (`cd tools && npm install && npm run help-gifs`).

## Tests

- `server/tests`: engine perft suite, room logic, rated rooms, ratings, lobby logic and session (fake transport), Node end-to-end over real sockets (rooms and the ranked lobby).
- `ws-worker/tests`: both Durable Objects against a mocked hibernation API and storage.
- The end-to-end suite also runs against `wrangler dev`: `E2E_URL=ws://127.0.0.1:8787 node --test tests/server-e2e.test.mjs`.
