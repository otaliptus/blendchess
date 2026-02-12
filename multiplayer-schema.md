# Multiplayer Protocol Schema

Version: `1.0.0`

All messages are JSON envelopes over WebSocket text frames:

```json
{
  "type": "<TYPE>",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {},
  "version": "1.0.0"
}
```

`roomCode` is required for all messages except `create_room`.

## Client -> Server

### `create_room`
```json
{
  "type": "create_room",
  "payload": { "nickname": "WhitePlayer" },
  "version": "1.0.0"
}
```

### `join_room`
```json
{
  "type": "join_room",
  "roomCode": "ABCD12",
  "payload": { "nickname": "BlackPlayer" },
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

### `claim_draw`
```json
{
  "type": "claim_draw",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": { "reason": "threefold|fiftyMove|seventyFiveMove|fivefold|insufficientMaterial" },
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
  "playerId": "player-id",
  "payload": {},
  "version": "1.0.0"
}
```

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
    "playerColor": "w",
    "playerId": "player-id",
    "players": [
      { "playerId": "player-id", "color": "w", "nickname": "WhitePlayer", "connected": true }
    ],
    "gameStarted": false,
    "game": { "turn": "w", "board": [], "boardVersion": 0 }
  },
  "version": "1.0.0"
}
```

### `room_joined`
```json
{
  "type": "room_joined",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {
    "roomCode": "ABCD12",
    "players": [
      { "playerId": "uuid1", "color": "w", "nickname": "White", "connected": true },
      { "playerId": "uuid2", "color": "b", "nickname": "Black", "connected": true }
    ],
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
  "payload": { "playerId": "player-id", "color": "b", "nickname": "BlackPlayer" },
  "version": "1.0.0"
}
```

### `game_state`
```json
{
  "type": "game_state",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {
    "game": {
      "roomCode": "ABCD12",
      "turn": "w",
      "board": [[{"type":"R","color":"b","hasMoved":true}]],
      "enPassant": null,
      "moveNumber": 9,
      "movePairs": [],
      "events": [],
      "captured": { "w": 0, "b": 0 },
      "winner": null,
      "result": null,
      "gameOver": false,
      "boardVersion": 18,
      "halfMoveClock": 16,
      "positionCounts": {},
      "waitingForStart": false,
      "players": []
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
  "playerId": "player-id",
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
    "game": { "turn": "b", "boardVersion": 19 },
    "moveNumber": 1,
    "boardVersion": 19,
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
  "payload": { "reasonCode": "ILLEGAL_MOVE", "moveIntent": {} },
  "version": "1.0.0"
}
```

### `draw_result`
```json
{
  "type": "draw_result",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": {
    "reason": "threefold",
    "game": { "result": "threefold", "gameOver": true },
    "winner": null
  },
  "version": "1.0.0"
}
```

### `resign_result`
```json
{
  "type": "resign_result",
  "roomCode": "ABCD12",
  "playerId": "player-id",
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
  "playerId": "player-id",
  "payload": { "errorCode": "ROOM_FULL", "message": "Room is already full" },
  "version": "1.0.0"
}
```

### `pong`
```json
{
  "type": "pong",
  "roomCode": "ABCD12",
  "playerId": "player-id",
  "payload": { "ts": 1700000000000 },
  "version": "1.0.0"
}
```

## Error Codes

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
