# Blendchess

Blendchess is a chess game where the information is intentionally limited in a [Kriegspiel](https://en.wikipedia.org/wiki/Kriegspiel_(chess)) style.

## What is different from normal online chess?

- The rules are classical chess; with a subtle difference: **you can only see your own pieces, and nothing else!**
- Opponent move coordinates/notation are masked while the game is live.
- Check warnings are still shown to the player whose king is in check.
- Once the game ends, full history is revealed and can be exported as PGN.

## Why the name Blendchess?

Well, blindchess is taken, and blind+chess is too long, and the game is literally fun blendy mess.

## Modes

- `Local Play`: pass-and-play on one device with full board visibility.
- `Online Play`: create/join room codes, backend-authoritative moves, reconnect support, optional spectators.
- `Spectate`: watch without taking a seat.

## Rules in plain English

- Legal moves, check, checkmate, stalemate, castling, promotion, and en passant follow standard chess logic (I won against a friend using en-passant by mistake once!)
- Draw logic includes threefold/fivefold repetition, 50/75-move rule, and insufficient material.
- Online mode is authoritative: the backend validates and applies moves.
- Hard mode is optional: illegal moves forfeit turn, except when the mover is in check (then illegal moves are rejected without forfeit).

## How to play

1. Open the game in your browser.
2. Choose `Local Play` or `Online Play`.
3. For online, create a room and share the code, or join/spectate an existing room.
4. Use `Draw`/`Resign` when needed, then export PGN after game end.

## Origin (Kriegspiel)

Blendchess is inspired by **Kriegspiel**, a historical chess variant built around incomplete information and an umpire ([Wikipedia](https://en.wikipedia.org/wiki/Kriegspiel_(chess))).
This project keeps core chess structure but adds selective hidden information to create a similar tension in online play.

## Motivation

This project initially started as a benchmark to test the latest Codex-Spark model ([OpenAI announcement](https://openai.com/index/introducing-gpt-5-3-codex-spark/)).

The first results were not great, so I decided to keep building it a few minutes a day, step by step, while playing with friends.
The goal is to make it stable enough to have fun in real places and parties.

I regularly used 5.3-Codex-Xhigh for core game logic, Opus 4.6 for frontend work, and some Gemini 3.0 Pro along the way.

## What's next

- Room-code sharded Durable Objects instead of a single global hub.
- Better abuse controls and telemetry across backend paths.
- More end-to-end websocket integration coverage.
- Leaderboards, rankings, fun stuff.

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

Use `wss://<worker-subdomain>.workers.dev` as the server URL in the app.

To set a default server URL, define before loading `app.js`:

```html
<script>
  window.BLENDCHESS_SERVER_URL = 'wss://blendchess-ws.<subdomain>.workers.dev';
</script>
```

## Notes

- Stale online snapshots are rejected by version checks.
- History snapshots are validated before restoring.
- PGN export is enabled only after the game ends.
- Spectator roster is shown as count, not spectator name list.

* Yes, I'm aware that you can see the moves by checking dev console. Will change that with a proper backend but I'm a bit lazy, feel free to submit a PR. 

Don't play with cheaters, perhaps?

## Documentation

- `ARCHITECTURE.md` — system design, component boundaries, scaling direction.
- `multiplayer-schema.md` — WebSocket protocol envelope and message schema.
- `server/README.md` — Node backend specifics.
- `ws-worker/README.md` — Cloudflare Worker backend specifics.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
