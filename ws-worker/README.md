# Blendchess Cloudflare WebSocket Worker

This Worker hosts multiplayer room state using a Durable Object.

## Deploy

```bash
cd ws-worker
npx wrangler login
npx wrangler whoami
npx wrangler deploy
```

After deploy, copy the Worker URL:

- `https://<worker-name>.<subdomain>.workers.dev`
- WebSocket URL in game UI is: `wss://<worker-name>.<subdomain>.workers.dev`

## Local worker dev

```bash
cd ws-worker
npx wrangler dev
```

Health endpoint:

- `GET /health`
