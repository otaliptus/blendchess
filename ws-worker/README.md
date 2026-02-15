# Blendchess Cloudflare WebSocket Worker

Cloudflare Worker + Durable Object backend for online games.

## Files

- Entry: `src/index.js`
- Durable Object: `src/room.js`
- Wrangler config: `wrangler.jsonc`

## Run locally

```bash
cd ws-worker
npm install
npm run dev
```

## Deploy

```bash
cd ws-worker
npx wrangler login
npx wrangler deploy
```

Use the deployed host in websocket form:
- `https://<worker>.workers.dev` -> `wss://<worker>.workers.dev`

## Health endpoint

- `GET /health`

## Current topology note

Current code routes all websocket sessions to one Durable Object name (`global-hub`).
This is simple and works, but it is a scale bottleneck compared to room-sharded DO routing.
