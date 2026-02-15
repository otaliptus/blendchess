# Multiplayer Implementation Checklist

## Foundation and core

- [x] Shared chess rules extracted to `chess-core.js`.
- [x] Browser app uses shared core and state guard helpers.
- [x] Protocol constants and envelope validation defined.
- [x] King capture blocked by rule layer with terminal safety fallback.

## Node authoritative backend

- [x] Room create/join/leave implemented.
- [x] Player seat assignment and reconnect resume tokens implemented.
- [x] Spectator join/read-only behavior implemented.
- [x] Move validation and authoritative apply path implemented.
- [x] Draw claim, resign, and new game flows implemented.
- [x] Hard mode enforcement implemented.
- [x] Illegal-in-check turn-forfeit path implemented.
- [x] Illegal move attempt events propagate to spectators.
- [x] Rate limit and message size guards implemented.

## Cloudflare backend

- [x] Worker entry and Durable Object authority implemented.
- [x] Room lifecycle and move flow mirrored in DO implementation.
- [x] Durable Object persistence implemented.
- [x] Hard mode illegal-forfeit behavior mirrored from Node path.
- [ ] Migrate from single `global-hub` DO to room-sharded DO mapping.
- [ ] Add stronger worker-level abuse controls and telemetry.

## Client UX and correctness

- [x] Local and online mode switch implemented.
- [x] Invite URL create/join flow implemented.
- [x] Setup cards and hint text for onboarding path.
- [x] Stale state hydration guard enforced.
- [x] History snapshot validation hardened.
- [x] PGN export gated to completed games.
- [x] Spectator list summarized as count, not names.
- [x] Opponent illegal attempt events masked from player timeline.
- [ ] Improve waiting-room indicators and first-time guidance.
- [ ] Add explicit reconnect/rejoin status banner for dropped sessions.

## Tests

- [x] Room manager unit tests for draw and hard mode behavior.
- [x] Room manager test for stale-seat cleanup ordering.
- [x] State guard tests for stale version and malformed snapshots.
- [ ] Add integration tests for full websocket flow (create/join/move/reconnect).
- [ ] Add worker-path tests for DO message handling and persistence behavior.
- [ ] Add replay smoke test coverage for final-game PGN/export flow.
