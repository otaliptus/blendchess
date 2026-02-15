# Blendchess

Blendchess is a browser chess game with local play, online friend rooms, and spectator mode.

## What the game does

- Runs directly from static frontend files (`index.html`, `style.css`, `app.js`).
- Uses one shared chess rules engine (`chess-core.js`) across frontend and backends.
- Supports local pass-and-play.
- Supports online friend rooms over websocket.
- Supports spectator read-only room view.
- Supports optional hard mode with stricter penalties for illegal play.

## How to run

### Local frontend only

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

### Local multiplayer backend (Node)

```bash
cd server
npm install
npm start
```

Use `ws://localhost:3000` in the app.

### Cloudflare backend

See `CLOUDFLARE_DEPLOY.md`.

## Core behavior summary

- Online mode is authoritative: backend validates and applies moves.
- Stale online snapshots are rejected by version checks.
- History snapshots are validated before restoring.
- PGN export is enabled only after the game ends.
- Spectator roster is shown as count, not spectator name list.

## Documentation map

- `ARCHITECTURE.md`: detailed system flow and component boundaries.
- `GAMEPLAY_EXPECTATIONS.md`: expected behavior and explicit non-goals.
- `MULTIPLAYER_QUICKSTART.md`: shortest multiplayer setup path.
- `multiplayer-schema.md`: websocket protocol envelope and message schema.
- `DETAILS.md`: compact project index.
