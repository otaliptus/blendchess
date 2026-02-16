# Blendchess Multiplayer Protocol Schema

Version: `1.0.0`  
Transport: WebSocket JSON envelopes.

## Canonical envelope

```json
{
  "type": "<TYPE>",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty-for-spectator-targets",
  "payload": {},
  "version": "1.0.0"
}
```

## Global rules

- `roomCode` is required for all messages except `create_room`.
- `version` must equal `1.0.0`, otherwise `error.errorCode = VERSION_MISMATCH`.
- Spectator-targeted server messages commonly use `playerId: ""`.
- `create_room` is the only room-less request.
- Node backend enforces payload size and per-connection message-rate limits.
- Worker backend currently does not mirror Node rate-limit/message-size guards yet.

## Client -> Server messages

### `create_room`

```json
{
  "type": "create_room",
  "payload": {
    "nickname": "WhitePlayer",
    "hardMode": false
  },
  "version": "1.0.0"
}
```

Notes:
- `nickname` is optional.
- `hardMode` is optional and coerced to boolean.

### `join_room`

Player join:

```json
{
  "type": "join_room",
  "roomCode": "ABCD12",
  "playerId": "existing-player-id-when-resuming",
  "payload": {
    "nickname": "BlackPlayer",
    "resume": false,
    "resumeToken": "optional"
  },
  "version": "1.0.0"
}
```

Spectator join:

```json
{
  "type": "join_room",
  "roomCode": "ABCD12",
  "payload": {
    "nickname": "Spectator",
    "spectator": true
  },
  "version": "1.0.0"
}
```

Resume requirements:
- `payload.resume === true`
- `playerId` must be provided
- `payload.resumeToken` must be valid for that seat

### `game_state`

```json
{
  "type": "game_state",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty-for-spectator",
  "payload": {},
  "version": "1.0.0"
}
```

Requests a fresh authoritative snapshot.

### `move_intent`

```json
{
  "type": "move_intent",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {
    "from": { "r": 6, "c": 4 },
    "to": { "r": 4, "c": 4 },
    "promotion": "Q"
  },
  "version": "1.0.0"
}
```

Notes:
- `from` and `to` must be board coordinates `0..7`.
- `promotion` is optional and must be valid promotion piece when present.

### `set_hard_mode`

```json
{
  "type": "set_hard_mode",
  "roomCode": "ABCD12",
  "playerId": "white-player-id",
  "payload": { "enabled": true },
  "version": "1.0.0"
}
```

Only White can toggle this.

### `claim_draw`

```json
{
  "type": "claim_draw",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {
    "reason": "threefold|fiftyMove|seventyFiveMove|fivefold|insufficientMaterial"
  },
  "version": "1.0.0"
}
```

`reason` is optional. Backend validates draw eligibility.

### `resign`

```json
{
  "type": "resign",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {},
  "version": "1.0.0"
}
```

### `new_game`

```json
{
  "type": "new_game",
  "roomCode": "ABCD12",
  "playerId": "white-player-id",
  "payload": {},
  "version": "1.0.0"
}
```

Only White can request this.

### `ping`

```json
{
  "type": "ping",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty-for-spectator",
  "payload": { "ts": 1700000000000 },
  "version": "1.0.0"
}
```

Payload is echoed in `pong`.

## Server -> Client messages

### `room_created`

```json
{
  "type": "room_created",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {
    "roomCode": "ABCD12",
    "role": "player",
    "playerColor": "w",
    "playerId": "player-id",
    "resumeToken": "resume-token",
    "players": [],
    "spectators": [],
    "gameStarted": false,
    "game": {}
  },
  "version": "1.0.0"
}
```

### `room_joined`

Player recipient form:

```json
{
  "type": "room_joined",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {
    "roomCode": "ABCD12",
    "role": "player",
    "players": [],
    "spectators": [],
    "gameStarted": true
  },
  "version": "1.0.0"
}
```

Spectator recipient form:

```json
{
  "type": "room_joined",
  "roomCode": "ABCD12",
  "playerId": "",
  "payload": {
    "roomCode": "ABCD12",
    "role": "spectator",
    "spectatorId": "spectator-id",
    "players": [],
    "spectators": [],
    "gameStarted": true
  },
  "version": "1.0.0"
}
```

### `player_assigned`

```json
{
  "type": "player_assigned",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {
    "playerId": "player-id",
    "color": "w|b",
    "nickname": "Player",
    "resumeToken": "resume-token-optional"
  },
  "version": "1.0.0"
}
```

Notes:
- Node includes `resumeToken` on create and join assignment.
- Worker includes `resumeToken` on create assignment.
- Worker join assignment currently omits `resumeToken`.

### `game_state`

```json
{
  "type": "game_state",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty",
  "payload": {
    "game": {}
  },
  "version": "1.0.0"
}
```

### `move_applied`

```json
{
  "type": "move_applied",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty",
  "payload": {
    "move": {
      "from": { "r": 6, "c": 4 },
      "to": { "r": 4, "c": 4 },
      "piece": "P",
      "capture": false,
      "castling": null,
      "enPassant": false,
      "promotion": null
    },
    "san": "e4",
    "nextTurn": "b",
    "game": {},
    "moveNumber": 1,
    "boardVersion": 1,
    "repetitionCount": 1
  },
  "version": "1.0.0"
}
```

### `move_rejected`

```json
{
  "type": "move_rejected",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {
    "reasonCode": "ILLEGAL_MOVE",
    "forfeited": false,
    "game": {},
    "moveIntent": {}
  },
  "version": "1.0.0"
}
```

Notes:
- `forfeited` is optional and set for hard-mode forfeits.
- `game` is included for forfeits.
- `moveIntent` echoes the submitted payload on rejections.

### `draw_result`

```json
{
  "type": "draw_result",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty",
  "payload": {
    "reason": "threefold|fiftyMove|seventyFiveMove|fivefold|insufficientMaterial",
    "winner": null,
    "game": {}
  },
  "version": "1.0.0"
}
```

### `resign_result`

```json
{
  "type": "resign_result",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty",
  "payload": {
    "winner": "White|Black",
    "game": {}
  },
  "version": "1.0.0"
}
```

### `error`

```json
{
  "type": "error",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty",
  "payload": {
    "errorCode": "ROOM_FULL",
    "message": "Room is already full"
  },
  "version": "1.0.0"
}
```

### `pong`

```json
{
  "type": "pong",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty",
  "payload": { "ts": 1700000000000 },
  "version": "1.0.0"
}
```

## `game` snapshot payload schema

`game_state`, `room_created.game`, `move_applied.game`, `draw_result.game`, and `resign_result.game` use this shape:

```json
{
  "roomCode": "ABCD12",
  "turn": "w|b",
  "board": [],
  "enPassant": null,
  "moveNumber": 1,
  "movePairs": [],
  "events": [],
  "captured": { "w": 0, "b": 0 },
  "winner": null,
  "result": null,
  "gameOver": false,
  "boardVersion": 0,
  "hardMode": false,
  "halfMoveClock": 0,
  "positionCounts": {},
  "waitingForStart": true,
  "players": [],
  "spectators": [],
  "spectatorCount": 0
}
```

Notes:
- `board` is 8x8 with `null` or piece objects `{ type, color, hasMoved }`.
- `spectatorCount` is present in Worker snapshots.
- `spectatorCount` is currently absent in Node snapshots.

## Runtime behavioral semantics

- Illegal move attempts never mutate authoritative position.
- Offending player receives `move_rejected`.
- On illegal attempt, non-offending peers receive a fresh `game_state`.
- In hard mode, illegal moves usually forfeit turn, except when the mover is in check; those in-check illegal attempts are rejected without forfeit.
- If an active game has a disconnected player seat, non-resume `join_room` is rejected (`PLAYER_NOT_FOUND`) and the seat stays reserved for resume token reclaim.
- Spectators are read-only and receive room/game updates.

## Error codes

- `INVALID_PAYLOAD`
- `UNKNOWN_ROOM`
- `ROOM_FULL`
- `NOT_YOUR_TURN`
- `WRONG_COLOR`
- `ILLEGAL_MOVE`
- `GAME_OVER`
- `ROOM_NOT_READY`
- `RATE_LIMIT`
- `PLAYER_NOT_FOUND`
- `INVALID_DRAW_CLAIM`
- `VERSION_MISMATCH`

## Implementation notes

- Node protocol enum contains `game_over`, but it is currently not emitted.
- Worker protocol enum does not include `game_over`.
- Treat `game_over` as reserved/unused for now.
