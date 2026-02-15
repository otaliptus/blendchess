# Blendchess Multiplayer Node Server

Authoritative websocket server for online games.

## Run

```bash
cd server
npm install
npm start
```

Default URL: `ws://localhost:3000`

Change port:

```bash
PORT=5000 npm start
```

Run tests:

```bash
npm test
```

## Architecture

- Transport: WebSocket (`ws`) with JSON protocol envelopes.
- Authority: all move legality and room lifecycle decisions are server-owned.
- Rules: shared `chess-core.js` + `chessEngineFacade.js`.
- Room state: in-memory map with TTL pruning for inactive rooms.
- Session model:
  - create/join room,
  - color seat assignment,
  - spectator support,
  - resume token reconnect.

## Safety controls

- Maximum websocket message size (`MAX_MESSAGE_BYTES`).
- Per-connection message rate limiting (`RATE_LIMIT_MAX_MESSAGES` / second).
- Protocol version validation (`PROTOCOL_VERSION`).

## Protocol docs

Message and error schema is documented in `../multiplayer-schema.md`.
