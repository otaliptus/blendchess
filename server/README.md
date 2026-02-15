# Blendchess Multiplayer Node Server

Authoritative websocket backend for online games.

## Run

```bash
cd server
npm install
npm start
```

Default URL: `ws://localhost:3000`

Optional port override:

```bash
PORT=5000 npm start
```

Run tests:

```bash
npm test
```

## Architecture

- Transport: WebSocket (`ws`) with JSON protocol envelopes.
- Authority: all legality and room lifecycle logic is server-owned.
- Rules engine: `chess-core.js` through `chessEngineFacade.js`.
- Room state: in-memory room map with TTL pruning.
- Session model: create/join room, player seat assignment, spectator join, reconnect via resume token.

## Behavior highlights

- Illegal move attempts are rejected without mutating board state.
- Hard mode forfeits turn on illegal moves, except when the mover is currently in check (that illegal move is rejected without forfeit).
- Opponent illegal attempts are masked in the player timeline.
- Spectators receive authoritative state updates and can observe illegal-attempt events.

## Safety controls

- Maximum message size (`MAX_MESSAGE_BYTES`).
- Per-connection message rate limiting (`RATE_LIMIT_MAX_MESSAGES` per second).
- Protocol version guard (`PROTOCOL_VERSION`).

## Protocol docs

Message and error schema: `../multiplayer-schema.md`.
