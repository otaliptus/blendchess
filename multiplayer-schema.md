# Blendchess multiplayer protocol (v2.0.0)

JSON messages over one WebSocket per room membership. Every message uses the same envelope:

```json
{
  "type": "move_intent",
  "roomCode": "ABCD12",
  "playerId": "seat-id-or-empty",
  "payload": {},
  "version": "2.0.0"
}
```

- `roomCode` is required for everything except `create_room`.
- A different `version` is rejected with `VERSION_MISMATCH`.
- Board coordinates are `{ r, c }` with `r = 0` on rank 8 and `c = 0` on the a-file.

## Connecting

The Cloudflare Worker gives every room its own Durable Object, so it routes on the query string:

| Purpose | URL |
| --- | --- |
| Ranked lobby (queue, identity) | `wss://<worker>/?lobby=1`, then send `lobby_hello` |
| Create a room | `wss://<worker>/?create=1`, then send `create_room` |
| Join, watch, resume | `wss://<worker>/?room=ABCD12`, then send `join_room`. Add `&seat=1` when coming with a ticket or resume token: a full room then makes space by closing a socket that holds no seat. |

The Node server accepts the same URLs and ignores the query string. Both backends also serve the HTTP
API below.

## HTTP API

JSON in, JSON out. Errors are `{ "error": "CODE", "message": "…" }` with a 4xx status.

Public reads (any origin, `Access-Control-Allow-Origin: *`, edge-cached for a few seconds on a custom domain):

| Route | Answer |
| --- | --- |
| `GET /api/leaderboard?limit=20` | `{ players: [summary + { live: roomCode \| null }], total }`. Only secured accounts are listed; `total` counts every rated player. `GET /leaderboard` is an alias. |
| `GET /api/live` | `{ games: [{ roomCode, control, rated, startedAt, white: { name, rating }, black: { … } }] }`, newest first, at most 50. |
| `GET /api/players/:name` | `{ player: summary, live: liveGame + { color } \| null, games: [{ id, color, outcome, result, rated, control, opponent: { name, rating }, delta, moves, endedAt }] }` (20 most recent). 404 if unknown. |
| `GET /api/games/:id` | `{ game: { id, rated, control, white: { name, before, after }, black: { … }, winner: "w" \| "b" \| null, result, startedAt, endedAt, plies } }`. Each ply is `[from, to, san, promotion, capture, forfeit]`. |

A player summary is `{ id, name, rating, peak, games, wins, losses, draws, provisional, secured, createdAt }`.

Account routes need the site's own `Origin` (configured `SITE_ORIGINS`, plus any `localhost`), and all but
the sign-in routes need `Authorization: Bearer <session token>`. `me` is `{ player: summary, security:
{ passkeys: [{ id, label, backedUp, createdAt, lastUsed }], hasKey, keyCreatedAt, sessions } }`.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/me` | | `me` |
| `POST /api/auth/passkey/register/options` | `{}` | `{ challengeId, options }` (WebAuthn creation options, JSON form) |
| `POST /api/auth/passkey/register/verify` | `{ challengeId, label, response }` | `me` |
| `POST /api/auth/passkey/remove` | `{ id }` | `me` |
| `POST /api/auth/passkey/login/options` | `{}` | `{ challengeId, options }` (no token needed) |
| `POST /api/auth/passkey/login/verify` | `{ challengeId, response }` | `{ token, player }` (no token needed) |
| `POST /api/auth/key/create` | `{}` | `{ key, ...me }`. The key is shown once; a new key retires the old one. |
| `POST /api/auth/key/remove` | `{}` | `me` |
| `POST /api/auth/key/login` | `{ key }` | `{ token, player }` (no token needed; case, dashes and the `BLND` prefix are optional) |
| `POST /api/auth/logout` | `{}` | `{ ok: true }`; lobby sockets opened with that session close with code `4001` |
| `POST /api/auth/logout-others` | `{}` | `me`; every other session of the account ends |

Sign-in rate limits: 30 account requests per minute per network, 10 failed sign-ins per minute per network.

## Ranked lobby

Lobby messages have no `roomCode`. The lobby is a single shared connection that carries identity,
queueing and the rating updates, while the game itself lives in a separate room socket.

### `lobby_hello`

```json
{ "type": "lobby_hello", "payload": { "token": "optional-saved-token", "nickname": "Wendy" }, "version": "2.0.0" }
```

No token (or an unknown one) creates a new identity. The reply carries the token exactly once:

```json
{ "type": "lobby_ready", "payload": {
  "player": { "id": "abc123def456", "name": "Wendy", "rating": 1200, "games": 0, "wins": 0, "losses": 0, "draws": 0, "provisional": true },
  "token": "…43 characters…",
  "queued": null
} }
```

On a later hello the token is not echoed back. Names are unique (case-insensitive); a taken name gets a
numeric suffix. A hello with a new nickname renames the player.

### `lobby_queue` / `lobby_cancel`

```json
{ "type": "lobby_queue", "payload": { "control": "5+3" }, "version": "2.0.0" }
```

Controls: `5+3` (Blitz) and `10+0` (Rapid). Queueing twice is idempotent; queueing while a ranked game
is unfinished answers `lobby_error` with `ALREADY_IN_GAME`. Matched players receive:

```json
{ "type": "match_found", "payload": {
  "roomCode": "ABCD12",
  "ticket": "…43 characters…",
  "color": "w",
  "control": "5+3",
  "clock": { "baseMs": 300000, "incMs": 3000 },
  "rated": true,
  "opponent": { "name": "Boris", "rating": 1240, "provisional": false }
} }
```

The client then opens `?room=ABCD12` and sends `join_room` with `"payload": { "ticket": "…" }`.
`rated` is false when both players share a network; the game is then a practice game.

`lobby_rating` is pushed when a rated game ends while the player is still connected to the lobby:

```json
{ "type": "lobby_rating", "payload": { "player": { … }, "update": { "before": 1200, "after": 1220, "delta": 20 } } }
```

`lobby_error` carries `errorCode` and `message` (`RATE_LIMIT`, `QUEUE_FULL`, `ALREADY_IN_GAME`,
`NOT_AUTHENTICATED`, `INVALID_PAYLOAD`).

## The core rule: per-viewer views

The server never sends the full game to a player while it is running. Every state change is
broadcast as a separate `game_state` per member, built by `createView(state, viewer)` in
`shared/room-logic.js`:

| Field | Player | Spectator (fog) | Spectator (party mode) | After game over |
| --- | --- | --- | --- | --- |
| `board` | own pieces only | empty | full | full |
| `moves[].san/from/to` | own plies only; `+`/`#` stripped | hidden | full | full |
| `moves[].capture.square` | yes | yes | yes | yes |
| `check` | only when *you* are in check | no | yes | n/a |
| `events` | public + your secrets | public | everything | everything |

## Client -> server

### `create_room`

```json
{ "type": "create_room", "payload": { "nickname": "Wendy", "hardMode": false, "spectatorView": "fog" }, "version": "2.0.0" }
```

`spectatorView`: `"fog"` (default) or `"open"` (party mode: spectators see the live board).

### `join_room`

```json
{ "type": "join_room", "roomCode": "ABCD12", "payload": { "nickname": "Boris" }, "version": "2.0.0" }
```

- Watch instead of play: `"payload": { "spectator": true }`.
- Resume a seat: top-level `playerId` plus `"payload": { "resume": true, "resumeToken": "..." }`.
- While a game is in progress, a disconnected player's seat is reserved; plain joins get `PLAYER_NOT_FOUND`.
- Resuming from a new socket detaches the old one (it is closed with code `4000`) without dropping the seat.

### `move_intent`

```json
{ "type": "move_intent", "roomCode": "ABCD12", "playerId": "seat", "payload": { "from": { "r": 6, "c": 4 }, "to": { "r": 4, "c": 4 }, "promotion": "Q" }, "version": "2.0.0" }
```

Illegal moves are rejected and announced to everyone as an `illegal` event; only the mover sees the squares.
In hard mode an illegal move forfeits the turn (recorded as a null move `--`) unless the mover is in check.

In a lobby-arranged room the join payload is `{ "ticket": "…" }`; without the ticket the answer is
`TICKET_INVALID`. Resuming a seated player still works with `resume: true` and the `resumeToken`.
Anyone may watch a lobby-arranged room with `{ "spectator": true }`: watchers see the whole board,
except that in a ranked game a watcher on the same network as a player sees that player's view
(`you.perspective` is then `"w"` or `"b"`).

### `set_options`

```json
{ "type": "set_options", "roomCode": "ABCD12", "playerId": "seat", "payload": { "hardMode": true, "spectatorView": "open" }, "version": "2.0.0" }
```

Either player may change options before the first move and between games. During a game: `GAME_IN_PROGRESS`.

### `claim_draw`

`payload.reason` is optional (`threefold`, `fiftyMove`, ...). The server ends the game if a claim is
available. Otherwise it records a draw offer, or accepts the opponent's pending offer. An offer stays up
through the offerer's own move and lapses when the opponent moves.

### `resign`, `new_game`, `game_state`, `ping`

- `resign`: ends the game; the opponent wins.
- `new_game`: allowed only when the game is over (or before the first move). Players swap colours after a finished game.
- `game_state`: asks for a fresh view.
- `ping`: answered with `pong`.

## Server -> client

### `room_created` / `room_joined`

```json
{ "type": "room_joined", "roomCode": "ABCD12", "playerId": "seat", "payload": { "roomCode": "ABCD12", "role": "player", "playerId": "seat", "color": "b", "resumeToken": "..." }, "version": "2.0.0" }
```

Spectators get `{ "role": "spectator", "spectatorId": "..." }`. A `game_state` always follows.

### `game_state`

```json
{
  "type": "game_state",
  "payload": {
    "game": {
      "roomCode": "ABCD12",
      "gameId": 1,
      "boardVersion": 7,
      "you": { "role": "player", "color": "b" },
      "revealed": false,
      "turn": "w",
      "board": [[null, "..."]],
      "moves": [{ "ply": 1, "color": "w", "san": null, "from": null, "to": null, "forfeit": false, "capture": null }],
      "events": [{ "id": 12, "at": 1760000000000, "kind": "capture", "color": "w", "captured": "b", "square": "d5", "r": 3, "c": 3 }],
      "captured": { "w": 0, "b": 1 },
      "check": { "color": "b", "directions": ["diagonal"] },
      "drawOffer": null,
      "gameOver": false,
      "winner": null,
      "result": null,
      "hardMode": false,
      "spectatorView": "fog",
      "rated": false,
      "reserved": false,
      "ratings": null,
      "clock": {
        "control": "5+3", "baseMs": 300000, "incMs": 3000,
        "w": 300000, "b": 297000, "turn": "b", "startedAt": 1760000000000,
        "running": true, "remaining": 297000, "sentAt": 1760000012345
      },
      "waitingForStart": false,
      "inProgress": true,
      "players": [{ "color": "w", "nickname": "Wendy", "connected": true }],
      "spectatorCount": 0
    }
  }
}
```

- `boardVersion` only ever increases, even across new games, so clients drop anything older than what they hold.
- `result`: `checkmate`, `resign`, `stalemate`, `mutualDraw`, `threefold`, `fivefold`, `fiftyMove`, `seventyFiveMove`, `insufficientMaterial`, `timeout`, `abandon`.
- `clock`: present only in lobby-arranged games. `w`/`b` are the stored clocks at send time and
  `remaining` is the side-to-move's remaining time (subtract local elapsed time since receipt). The
  server owns it; moving without enough time loses on the spot.
- `rated`: the game counts for Elo. `reserved`: the seats were fixed by the lobby and need tickets.
  `ratings` appears in the final views (`{ w: {before, after, delta}, b: {…} }`) once the result has
  been reported, and `recordId` once the lobby has stored the game (`GET /api/games/:id`).
- `you`: `{ role, color, perspective }`. `color` is the seat (players only); `perspective` is the side a
  same-network spectator is limited to, otherwise `null`.
- Event kinds: `move`, `capture`, `check`, `illegal`, `forfeit`, `draw_offer`, `draw_declined`, `resign`, `game_over`, `presence`, `options`, `new_game`. Event `id`s increase, so a client can tell which ones are new.
- `check.directions`: any of `file`, `rank`, `diagonal`, `knight`.

### `move_rejected`

Sent only to the actor. Carries `reasonCode`, `forfeited` (hard mode), and the actor's fresh `game` view.
It is also used for refused `set_options`, `new_game`, `claim_draw` and `resign` requests.

### `error`

`payload.errorCode` is one of `INVALID_PAYLOAD`, `UNKNOWN_ROOM`, `ROOM_FULL`, `NOT_YOUR_TURN`, `WRONG_COLOR`,
`ILLEGAL_MOVE`, `GAME_OVER`, `GAME_IN_PROGRESS`, `ROOM_NOT_READY`, `RATE_LIMIT`, `PLAYER_NOT_FOUND`,
`INVALID_DRAW_CLAIM`, `VERSION_MISMATCH`, `TICKET_INVALID`, `SPECTATOR_DISABLED` (no longer sent by
current servers), `RATED_LOCKED`, plus a
human-readable `message`. Lobby errors use `QUEUE_FULL`, `ALREADY_IN_GAME`, `NOT_AUTHENTICATED`.

## Limits (both backends)

- 16 KiB per message, 40 messages per second per socket.
- Nicknames: 16 characters, markup stripped.
- Node: up to 10,000 rooms in memory. Worker: up to 64 sockets per room, 4 per network.
- Lobby: 500 queued players, 6 per network; 6 lobby sockets per network; 10 new identities per network
  per hour; room creation capped per network and globally.
- "Per network" means per IPv4 address or per IPv6 /64.
- Idle rooms with nobody connected are deleted after an hour (Worker: Durable Object alarm).
