# Multiplayer Quickstart

## 1) Start the game files

From the repo root:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080` in your browser.

## 2) Start the multiplayer server

In a separate terminal:

```bash
cd server
npm install
npm start
```

Server default is `ws://localhost:3000`.

## 3) Play with a friend on the same machine

1. On the first tab:
   - Change **Mode** to `Online Friend`.
   - Click **Connect**.
   - Click **Create room**.
   - Copy the invite link with **Copy invite**.
2. On the second tab (same machine, same local page):
   - Change **Mode** to `Online Friend`.
   - Click **Connect**.
   - Paste room code in **Room code** input.
   - Click **Join room**.
3. You should see:
   - Host assigned White.
   - Joiner assigned Black.
   - The board updates after each valid move.

## 4) Local mode (single-browser)

Set **Mode** to `Local` and play immediately as before.

## 5) Quick checks

- If a move fails in online mode, check the Events list for a server message.
- If friend cannot move, verify seat colors and whose turn are shown in the status bar.

## 6) Cloudflare hosted mode (Pages + Worker)

Use this when playing with a friend over the internet without running your local Node server.

1. Deploy multiplayer Worker:
   - `cd ws-worker`
   - `npx wrangler login`
   - `npx wrangler deploy`
   - Copy Worker URL, convert to WebSocket URL (`https://...` -> `wss://...`).
2. Deploy static app to Pages:
   - `cd /Users/talip/Desktop/blendchess`
   - `npx wrangler pages project create blendchess`
   - `npx wrangler pages deploy . --project-name=blendchess`
3. Play:
   - Open Pages URL.
   - Set mode to `Online Friend`.
   - Paste Worker `wss://...` URL in `Server WS URL`.
   - Connect, create room, share room code.
