# Cloudflare Deploy (Pages + Worker Durable Object)

This project deploys as:
- Frontend: Cloudflare Pages (static files from repo root)
- Multiplayer backend: Cloudflare Worker + Durable Object (`ws-worker/`)

## 1) Deploy Worker backend

```bash
cd ws-worker
npx wrangler login
npx wrangler deploy
```

Configuration source: `ws-worker/wrangler.jsonc`

Take deployed host from output, for example:
- `https://blendchess-ws.<subdomain>.workers.dev`

Use websocket form in app:
- `wss://blendchess-ws.<subdomain>.workers.dev`

## 2) Deploy static app to Pages

From repo root:

```bash
npx wrangler pages project create blendchess
npx wrangler pages deploy . --project-name=blendchess
```

Pages URL will look like:
- `https://blendchess.pages.dev`

## 3) Play online

1. Open Pages URL.
2. Set mode to `Online Friend`.
3. Enter worker websocket URL (`wss://...`) if needed.
4. Click `Connect`.
5. Click `Create room` and share code/invite.
6. Friend opens same Pages URL and joins with same room code.

## Optional default WS URL

To prefill your backend URL, define this global before loading `app.js`:

```html
<script>
  window.BLENDCHESS_SERVER_URL = 'wss://blendchess-ws.<subdomain>.workers.dev';
</script>
```
