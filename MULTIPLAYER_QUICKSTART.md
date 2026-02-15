# Multiplayer Quickstart

## Option A: Run local static app + local Node multiplayer server

### 1) Start static files
From repo root:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.

### 2) Start multiplayer server
In a second terminal:

```bash
cd server
npm install
npm start
```

Default WebSocket URL is `ws://localhost:3000`.

### 3) Play on two tabs/devices
1. Open app and set `Mode` to `Online Friend`.
2. Click `Connect`.
3. Click `Create room`.
4. Share room code or invite link.
5. Second player connects and joins with the same code.

## Option B: Use Cloudflare Worker backend

1. Deploy Worker from `ws-worker/`.
2. Convert worker URL to websocket form (`https://...` -> `wss://...`).
3. In app, paste that URL into `Server WS URL` and connect.
4. Create room and share code.

## Local mode fallback

Set `Mode` to `Local` and play pass-and-play with no backend.

## Quick troubleshooting

- `Room does not exist`: verify exact room code and backend URL.
- `Room full`: two players are already seated.
- `Not your turn`: move ownership is enforced server-side.
- `Version mismatch`: refresh both clients so protocol versions match.
