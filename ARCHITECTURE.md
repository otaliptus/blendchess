# Blendchess architecture

## Components

| Path | Role |
| --- | --- |
| `chess-core.js` | Rules engine: move generation, check, terminal states, SAN, plausible moves for the fog |
| `shared/protocol.js` | Message types, error codes, envelope parsing |
| `shared/engine-facade.js` | Validates a move intent against the legal moves |
| `shared/room-logic.js` | Room and game authority, **per-viewer redaction** (`createView`), PGN |
| `shared/room-session.js` | Message handling for one room, written against a tiny transport interface |
| `server/` | Node transport (`ws`), in-memory rooms |
| `ws-worker/` | Cloudflare Worker transport: one Durable Object per room |
| `index.html`, `style.css`, `app.js`, `client/` | Static pixel-art client |

The shared modules are plain classic scripts that publish themselves on `globalThis` and also set
`module.exports`. The browser loads them with `<script>` tags, Node with `require`, and Wrangler bundles
them as side-effect imports. Load order: `chess-core.js` -> `protocol.js` -> `engine-facade.js` ->
`room-logic.js` -> `room-session.js`.

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

## Game rules worth knowing

- `boardVersion` is monotonic for the life of a room, so clients can always drop stale snapshots, including after a rematch.
- Forfeited turns are recorded as plies (`--`), so colours always alternate in the move list, replay and PGN.
- A forfeit clears the en passant square.
- Options (hard mode, party mode) are locked between the first move and the end of the game.
- `new_game` is refused while a game is in progress; after a finished game the players swap colours.
- Automatic draws: stalemate, fivefold repetition, the 75-move rule, and dead positions (K v K, a single minor piece, or same-coloured bishops only). Threefold and the 50-move rule must be claimed.

## Client

`app.js` renders views; it never decides legality. Local pass-and-play runs the same `room-logic.js` in
the browser and switches the board to the side to move after each turn. A turn banner above the board
says whose move it is and summarizes what the opponent did.
Supporting modules:

- `client/sprites.js`: 16x16 pixel pieces and the umpire, drawn to canvas once and cached as data URLs.
- `client/sfx.js`: a small WebAudio chiptune synth (effects plus optional music).
- `client/fx.js`: particles, screen shake, banners and typewriter text. All of it respects `prefers-reduced-motion`.
- `client/stateGuards.js`: snapshot version checks.
- `assets/help/*.gif`: the how-to-play animations, rendered from the same sprites by `tools/make-help-gifs.mjs` (`cd tools && npm install && npm run help-gifs`).

## Tests

- `server/tests`: engine perft suite, room logic, session (fake transport), Node end-to-end over real sockets.
- `ws-worker/tests`: Durable Object against a mocked hibernation API.
- The end-to-end suite also runs against `wrangler dev`: `E2E_URL=ws://127.0.0.1:8787 node --test tests/server-e2e.test.mjs`.
