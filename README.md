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

### Cloudflare backend (Pages + Worker Durable Object)

Deploy Worker backend:

```bash
cd ws-worker
npx wrangler login
npx wrangler deploy
```

Deploy frontend to Pages:

```bash
npx wrangler pages project create blendchess
npx wrangler pages deploy . --project-name=blendchess
```

Use `wss://<worker-subdomain>.workers.dev` as the server URL in the app.

To set a default server URL, define before loading `app.js`:

```html
<script>
  window.BLENDCHESS_SERVER_URL = 'wss://blendchess-ws.<subdomain>.workers.dev';
</script>
```

## Core behavior summary

- Online mode is authoritative: backend validates and applies moves.
- Stale online snapshots are rejected by version checks.
- History snapshots are validated before restoring.
- PGN export is enabled only after the game ends.
- Spectator roster is shown as count, not spectator name list.

## Documentation

- `ARCHITECTURE.md` — system design, component boundaries, scaling direction.
- `multiplayer-schema.md` — WebSocket protocol envelope and message schema.
- `server/README.md` — Node backend specifics.
- `ws-worker/README.md` — Cloudflare Worker backend specifics.
