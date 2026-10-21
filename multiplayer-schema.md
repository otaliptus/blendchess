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
| Create a room | `wss://<worker>/?create=1`, then send `create_room` |
| Join, watch, resume | `wss://<worker>/?room=ABCD12`, then send `join_room` |

The Node server accepts the same URLs and ignores the query string.

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
      "waitingForStart": false,
      "inProgress": true,
      "players": [{ "color": "w", "nickname": "Wendy", "connected": true }],
      "spectatorCount": 0
    }
  }
}
```

- `boardVersion` only ever increases, even across new games, so clients drop anything older than what they hold.
- `result`: `checkmate`, `resign`, `stalemate`, `mutualDraw`, `threefold`, `fivefold`, `fiftyMove`, `seventyFiveMove`, `insufficientMaterial`.
- Event kinds: `move`, `capture`, `check`, `illegal`, `forfeit`, `draw_offer`, `draw_declined`, `resign`, `game_over`, `presence`, `options`, `new_game`. Event `id`s increase, so a client can tell which ones are new.
- `check.directions`: any of `file`, `rank`, `diagonal`, `knight`.

### `move_rejected`

Sent only to the actor. Carries `reasonCode`, `forfeited` (hard mode), and the actor's fresh `game` view.
It is also used for refused `set_options`, `new_game`, `claim_draw` and `resign` requests.

### `error`

`payload.errorCode` is one of `INVALID_PAYLOAD`, `UNKNOWN_ROOM`, `ROOM_FULL`, `NOT_YOUR_TURN`, `WRONG_COLOR`,
`ILLEGAL_MOVE`, `GAME_OVER`, `GAME_IN_PROGRESS`, `ROOM_NOT_READY`, `RATE_LIMIT`, `PLAYER_NOT_FOUND`,
`INVALID_DRAW_CLAIM`, `VERSION_MISMATCH`, plus a human-readable `message`.

## Limits (both backends)

- 16 KiB per message, 40 messages per second per socket.
- Nicknames: 16 characters, markup stripped.
- Node: up to 10,000 rooms in memory. Worker: up to 64 sockets per room.
- Idle rooms with nobody connected are deleted after an hour (Worker: Durable Object alarm).
