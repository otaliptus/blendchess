# Multiplayer Protocol Schema

Version: `1.0.0`
Transport: WebSocket JSON envelopes.

```json
{
  "type": "<TYPE>",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty-for-spectator",
  "payload": {},
  "version": "1.0.0"
}
```

Notes:
- `roomCode` is required for every message except `create_room`.
- In spectator responses, `playerId` can be an empty string.
- Server and client reject version mismatches with `VERSION_MISMATCH`.

## Client -> Server

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

### `join_room`
Player join:
```json
{
  "type": "join_room",
  "roomCode": "ABCD12",
  "playerId": "existing-player-id-for-resume-optional",
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

Resume requires all of:
- `payload.resume === true`
- `playerId`
- `payload.resumeToken`

### `game_state`
```json
{
  "type": "game_state",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {},
  "version": "1.0.0"
}
```

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

### `ping`
```json
{
  "type": "ping",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": { "ts": 1700000000000 },
  "version": "1.0.0"
}
```

## Server -> Client

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
    "resumeToken": "player-resume-token",
    "players": [],
    "spectators": [],
    "gameStarted": false,
    "game": { "turn": "w", "boardVersion": 0 }
  },
  "version": "1.0.0"
}
```

### `room_joined`
Player form:
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

Spectator form:
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
    "color": "b",
    "nickname": "BlackPlayer",
    "resumeToken": "player-resume-token"
  },
  "version": "1.0.0"
}
```

### `game_state`
```json
{
  "type": "game_state",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty",
  "payload": {
    "game": {
      "roomCode": "ABCD12",
      "turn": "w",
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
      "halfMoveClock": 0,
      "positionCounts": {},
      "waitingForStart": true,
      "hardMode": false,
      "players": [],
      "spectators": []
    }
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
    "game": { "boardVersion": 1 },
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
    "moveIntent": {}
  },
  "version": "1.0.0"
}
```

### `draw_result`
```json
{
  "type": "draw_result",
  "roomCode": "ABCD12",
  "playerId": "player-id-or-empty",
  "payload": {
    "reason": "threefold",
    "winner": null,
    "game": { "result": "threefold", "gameOver": true }
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
    "winner": "White",
    "game": { "result": "resign", "gameOver": true }
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
