# Blendchess Multiplayer Server

This folder is the multiplayer authority host.

## Run

```bash
cd server
npm install
npm start
```

Run tests:

```bash
npm test
```

Set `PORT` to change listening port:

```bash
PORT=5000 npm start
```

## Connection model

- WebSocket server only (no HTTP API currently).
- Clients send and receive JSON envelopes described in `multiplayer-schema.md`.
- Server is authoritative; all move legality checks happen here.
