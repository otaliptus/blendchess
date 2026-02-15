# Multiplayer Implementation Checklist

## Foundation and core

- [x] Shared chess rules extracted to `chess-core.js`.
- [x] Browser app uses shared core and state guard helpers.
- [x] Protocol constants and envelope validation defined.

## Node authoritative backend

- [x] Room create/join/leave implemented.
- [x] Player seat assignment and reconnect resume tokens implemented.
- [x] Spectator join/read-only behavior implemented.
- [x] Move validation and authoritative apply path implemented.
- [x] Draw claim, resign, and new game flows implemented.
- [x] Hard mode server enforcement implemented.
- [x] Rate limit and message size guards implemented.

## Cloudflare backend

- [x] Worker entry and Durable Object authority implemented.
- [x] Room lifecycle and move flow mirrored in DO implementation.
- [x] Durable Object persistence implemented.
- [ ] Migrate from single `global-hub` DO to room-sharded DO mapping.
- [ ] Add stronger worker-level abuse controls and telemetry.

## Client UX and correctness

- [x] Local and online mode switch implemented.
- [x] Invite URL create/join flow implemented.
- [x] Stale state hydration guard enforced.
- [x] History snapshot validation hardened.
- [ ] Simplify create/join onboarding flow further.
- [ ] Improve waiting-room indicators and first-time guidance.

## Tests

- [x] Room manager unit tests for draw and hard mode behavior.
- [x] Room manager test for stale-seat cleanup ordering.
- [x] State guard tests for stale version and malformed snapshots.
- [ ] Add integration tests for full websocket flow (create/join/move/reconnect).
- [ ] Add worker-path tests for DO message handling and persistence behavior.
