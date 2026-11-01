# Blendchess

Blendchess is a chess game where the information is intentionally limited in a [Kriegspiel](https://en.wikipedia.org/wiki/Kriegspiel_(chess)) style.

![Gameplay](gameplay.gif)

## What is different from normal online chess?

- The rules are classical chess; with a subtle difference: **you can only see your own pieces, and nothing else!**
- An umpire announces what both players would hear in Kriegspiel: someone moved, a piece was captured (and where), someone tried an illegal move.
- Check is announced only to the player in check, together with where it comes from (file, rank, diagonal or knight).
- Once the game ends the fog lifts: replay every move and export the PGN.

## Why the name Blendchess?

Well, blindchess is taken, and blind+chess is too long, and the game is literally fun blendy mess.

## Modes

- `Local Duel`: pass-and-play on one device. The board flips to the side to move and shows only their pieces; a banner on top says whose turn it is and what the opponent just did.
- `Create Room` / `Join Room`: create a room and send its invite link, or join or watch with a code. Reconnects resume your seat automatically.
- `Play Online`: open matchmaking from the main menu. Pick Blitz 5+3 or Rapid 10+0 and **Find game** to get paired by rating, play with a server-enforced clock, and climb the Elo leaderboard.
- `Watch & rankings`: available inside **Play Online**. Every game the lobby arranges is listed under **Live now** and anyone can watch it with the whole board visible. In private rooms spectators see the fog, unless the host turns on **party mode**.
- `Profiles`: every player has a public page with their rating, record and recent games. Each game opens as a full replay with a shareable link (`?game=...`); profiles are at `?p=name`.
- `Archive`: finished games are saved on your device for replay and PGN export.

## Accounts

- **Start as a guest.** Opening **Play Online** makes you an account, with nothing to fill in. It lives in this browser only. Open **Edit name** to change your nickname.
- **Save your progress.** In `ACCOUNT`, choose **Save with passkey** (your phone or computer's face, fingerprint or PIN; it syncs through your password manager). **Use an account key instead** offers a code you save somewhere safe (`BLND-XXXX-...`); it works on any device. Either one lets you sign in on another device and keeps your rating if you clear the browser. Having both is a backup. Existing accounts can use **Already have an account? Sign in**.
- **Devices.** Each browser you sign in on gets its own session. Under **Devices & sign out**, `SIGN OUT OTHER DEVICES` ends all of them but the one you're on, including any ranked game they are sitting in (their clock keeps running).
- **Leaderboard.** Guests are rated like everyone else, but only secured accounts are listed.
- Passkeys are offered on `blendchess.pages.dev`, `blendchess.com` (including `www`) and `localhost` for development. A passkey belongs to the domain it was made on. To move the same account between Pages and the custom domain, sign in with an account key and add a passkey on the new domain.
- Normal deployments preserve accounts and games. An intentional full reset is controlled by `DATA_VERSION` in `shared/protocol.js`; see [release resets](ws-worker/README.md#intentional-release-resets). The initial value `1` preserves all existing data.

## Ranked play

- **Elo.** Start at 1200. K=40 for your first 10 games, then 24. A win against a stronger player is worth more, and the rating is only ever changed by the server when a game it arranged ends.
- **Clocks.** Blitz 5+3 and Rapid 10+0. The clock runs on the server: time is charged on every move and the flag falls even if both tabs are closed. Disconnecting does not stop your clock.
- **Leaving.** Leaving a ranked game keeps the seat reserved, but the clock keeps running. If it runs out, the game is lost on time.
- **Matches.** The matchmaker pairs players with nearby ratings, widening the window the longer you wait, and avoids immediate rematches.

### Ranked fair play

The server is the authority for everything that decides a rating:

- Ranked rooms are created only by the lobby, for exactly two players. Each seat is locked by a random ticket handed to that player; without it nobody can take a seat.
- Anyone can watch a lobby game and sees the whole board live. Players are trusted not to watch their own games.
- Results are reported by the room itself, once per game, and the lobby only accepts results for games it arranged. Duplicate reports change nothing.
- Two accounts on the same network get an unrated practice game instead.
- Rating changes are clamped, new identities are rate limited per network, and the queue, room creation, socket count, message size and message rate are all capped.
- Options (hard mode, party mode) are fixed in lobby-arranged games.

What it cannot stop: someone running an engine locally, two accounts on different networks colluding, or a player watching their own game, since live boards are public. Ranked is for fun and players are trusted; the same-network rule, the rating clamp and rematch avoidance only make boosting take effort.

## Rules in plain English

- Legal moves, check, checkmate, stalemate, castling, promotion, and en passant follow standard chess logic (I won against a friend using en-passant by mistake once!)
- Draw logic includes threefold/fivefold repetition, 50/75-move rule, and insufficient material.
- Online mode is authoritative: the backend validates moves and clocks, and each player only ever receives their own view of the game. Ranked ratings are computed and stored on the server.
- Hard mode is optional: illegal moves forfeit the turn (recorded as `--` in the PGN), except when the mover is in check.
- Rules options lock once the first move is played. A draw offer stands until the opponent moves. Rematches swap colours.

## How to play

1. Choose **Play Online** from the main menu, then **Find game**. Rapid (10 minutes) is selected by default; Blitz (5 minutes + 3 seconds per move) is also available.
2. For a private game, choose **Create Room** or **Join Room**. Choose **Local Duel** to share a device. Optional hard mode and spectator settings are under **Game options**.
3. Click or drag your pieces. Dots mark squares that *might* be legal; dashed corners are pawn captures worth a try. Keyboard works too: arrows, Enter, Esc.
4. Offer a draw or resign when needed. After the game: replay, PGN, rematch.

Retro extras: four palettes, CRT scanlines, chiptune sound effects and optional music, all under **Settings**. Motion effects respect `prefers-reduced-motion`.

## Origin (Kriegspiel)

Blendchess is inspired by **Kriegspiel**, a historical chess variant built around incomplete information and an umpire ([Wikipedia](https://en.wikipedia.org/wiki/Kriegspiel_(chess))).
This project keeps core chess structure but adds selective hidden information to create a similar tension in online play.

## Motivation

This project initially started as a benchmark to test the latest Codex-Spark model ([OpenAI announcement](https://openai.com/index/introducing-gpt-5-3-codex-spark/)).

The first results were not great, so I decided to keep building it a few minutes a day, step by step, while playing with friends.
The goal is to make it stable enough to have fun in real places and parties.

I regularly used 5.3-Codex-Xhigh for core game logic, Opus 4.6 for frontend work, and some Gemini 3.0 Pro along the way.

## What's next

- Kriegspiel pawn-try announcements ("any captures?") as an optional rule.
- Tournament and club rooms.

## How to run on your own

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

Use `wss://<worker-subdomain>.workers.dev` as the server URL in the app (SETTINGS > ADVANCED). Each room runs in its own Durable Object, and one `LobbyHub` Durable Object holds the ranked queue and ratings. The worker also serves `GET /leaderboard?limit=20`.

To set a default server URL, define before loading `app.js`:

```html
<script>
  window.BLENDCHESS_SERVER_URL = 'wss://blendchess-ws.<subdomain>.workers.dev';
</script>
```

## Notes

- The server redacts every message per viewer, so the dev console shows only your own pieces and moves. Spectators of a private room see the fog too (unless party mode is on); lobby games are public and watchers see the whole board.
- Stale online snapshots are rejected by version checks.
- PGN export is enabled only after the game ends.
- Spectator roster is shown as count, not spectator name list.

## Tests

```bash
cd server && npm ci && npm test        # engine perft, room logic, session, Node end-to-end
cd ws-worker && npm ci && npm test     # Durable Object (mocked hibernation API)
# same end-to-end suite against the real Worker runtime:
cd ws-worker && npx wrangler dev --port 8787 &
cd server && E2E_URL=ws://127.0.0.1:8787 node --test tests/server-e2e.test.mjs
```

## Documentation

- `ARCHITECTURE.md` — system design, component boundaries, scaling direction.
- `multiplayer-schema.md` — WebSocket protocol envelope and message schema.
- `server/README.md` — Node backend specifics.
- `ws-worker/README.md` — Cloudflare Worker backend specifics.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
