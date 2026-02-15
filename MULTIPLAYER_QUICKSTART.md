# Multiplayer Quickstart

## Option A: Local static client + local Node server

### 1) Run the frontend
From repo root:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.

### 2) Run the multiplayer server
In another terminal:

```bash
cd server
npm install
npm start
```

Default WebSocket URL: `ws://localhost:3000`.

### 3) Play
1. Open app and set `Mode` to `Online Friend`.
2. Click `Connect`.
3. Click `Create room`.
4. Share room code or invite link.
5. Second player joins with same code.
6. Optional: a third tab can click `Spectate` with the same room code.

## Option B: Cloudflare Worker backend

1. Deploy Worker from `ws-worker/`.
2. Convert URL (`https://...`) to websocket (`wss://...`).
3. Paste into `Server WS URL`.
4. Connect and create/join rooms as above.

## Gameplay notes that affect multiplayer behavior

- Online mode is authoritative: server/worker validates and applies moves.
- Illegal move attempts do not mutate board state.
- Hard mode: illegal move while in check forfeits the turn.
- Spectator UI is read-only and shows spectator count, not spectator names.

## Troubleshooting

- `Room does not exist`: check exact room code and backend URL.
- `Room full`: both player seats are occupied.
- `Not your turn`: enforced by backend.
- `Version mismatch`: update both clients/server to same protocol version.
