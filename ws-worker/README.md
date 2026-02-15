# Blendchess Cloudflare WebSocket Worker

Cloudflare Worker + Durable Object backend for online games.

## Files

- Entry: `src/index.js`
- Durable Object authority: `src/room.js`
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

WebSocket URL format:
- `https://<worker>.workers.dev` -> `wss://<worker>.workers.dev`

## Health endpoint

- `GET /health`

## Behavior parity with Node backend

- Authoritative move validation and room lifecycle.
- Illegal moves are rejected without board mutation.
- Hard mode supports illegal-in-check turn forfeits.
- Spectators are read-only and receive authoritative game-state updates.

## Topology note

Current code routes all websocket sessions to a single Durable Object (`global-hub`).
This is simple but can become a hotspot; room-sharded Durable Objects are the next scaling step.
