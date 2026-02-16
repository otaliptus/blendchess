# Gameplay Expectations and Non-Goals

## What is expected

- Standard chess legality is enforced by shared rules logic.
- Online mode is authoritative: backend is source of truth for room/game state.
- Illegal moves are rejected and do not mutate board state.
- Hard mode forfeits turn for illegal moves, except when the mover is in check (those moves are rejected without forfeit).
- Stale snapshots are ignored via monotonic version checks.
- Saved history entries are validated before restore.
- Spectators are read-only.
- If an active game has a disconnected player seat, that seat is reserved for token-based resume (plain join is rejected).
- Spectator header shows count (`Spectators: N`) instead of spectator names.
- PGN export is available only after game over.

## What is not expected

- No ranking system, ladder, or matchmaking.
- No guaranteed persistence across Node server restart (in-memory backend path).
- No guarantee of zero packet loss/reordering at network layer; state version guards handle stale delivery.
- No anti-cheat beyond authoritative move validation and protocol guards.
- No replay-perfect forensic log intended for moderation tooling.
- No guarantee that current Worker topology (`global-hub`) scales linearly to very high room counts.

## Player-facing behavior notes

- In player view, opponent illegal attempts are intentionally not shown as move events.
- In spectator view, illegal attempts are visible in the room event stream.
- If both seats are occupied, further joins default to spectator role when selected.

## Operational expectations

- Node backend is best for local/dev and modest traffic unless fronted by additional infra.
- Worker backend is preferred for internet-facing deployment, with planned room sharding for higher scale.
