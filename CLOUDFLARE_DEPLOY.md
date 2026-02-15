# Cloudflare Deploy (Pages + Worker Durable Object)

Deployment split:
- Frontend: Cloudflare Pages (static site from repo root).
- Multiplayer backend: Cloudflare Worker + Durable Object (`ws-worker/`).

## 1) Deploy Worker backend

```bash
cd ws-worker
npx wrangler login
npx wrangler deploy
```

Config source: `ws-worker/wrangler.jsonc`

Example output host:
- `https://blendchess-ws.<subdomain>.workers.dev`

Use websocket form in client:
- `wss://blendchess-ws.<subdomain>.workers.dev`

## 2) Deploy frontend to Pages

From repo root:

```bash
npx wrangler pages project create blendchess
npx wrangler pages deploy . --project-name=blendchess
```

Example Pages URL:
- `https://blendchess.pages.dev`

## 3) Connect game clients

1. Open Pages URL.
2. Set mode to `Online Friend`.
3. Set server URL to deployed worker `wss://...` when needed.
4. Connect, create room, and share code/link.

## Optional default WS URL

Define before loading `app.js`:

```html
<script>
  window.BLENDCHESS_SERVER_URL = 'wss://blendchess-ws.<subdomain>.workers.dev';
</script>
```

## Current scaling note

Worker currently routes all rooms through one Durable Object (`global-hub`).
It works for small to moderate traffic, but room-sharded Durable Objects are recommended for larger scale.
