# Cloudflare Deploy (Pages + Durable Object Worker)

This repo now deploys as:

- Frontend: Cloudflare Pages (static files from repo root)
- Multiplayer backend: Cloudflare Worker + Durable Object (`ws-worker/`)

## 1) Deploy multiplayer Worker

```bash
cd ws-worker
npx wrangler login
npx wrangler whoami
npx wrangler deploy
```

Copy deployed Worker host from output:

- Example: `https://blendchess-ws.account-subdomain.workers.dev`
- In app use WebSocket form: `wss://blendchess-ws.account-subdomain.workers.dev`

## 2) Deploy static app to Pages

From repo root:

```bash
cd /Users/talip/Desktop/blendchess
npx wrangler pages project create blendchess
npx wrangler pages deploy . --project-name=blendchess
```

Pages URL will be like:

- `https://blendchess.pages.dev`

## 3) Play with a friend

1. Open your Pages URL.
2. Set Mode to `Online Friend`.
3. In `Server WS URL`, paste your Worker URL in `wss://...` form.
4. Click `Connect`.
5. Click `Create room` and share the room code.
6. Friend opens same Pages URL, pastes same `wss://...` Worker URL, connects, joins with room code.

## Optional default Worker URL

If you want the app to auto-fill your deployed Worker URL, set this global before loading `app.js`:

```html
<script>
  window.BLENDCHESS_SERVER_URL = 'wss://blendchess-ws.account-subdomain.workers.dev';
</script>
```

Then no manual Server URL paste is needed.
