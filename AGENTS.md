Build/Lint/Test: no build system; open `index.html` directly or run `python3 -m http.server`.
Build/Lint/Test: no automated lint/test commands are defined; single-test runs are not applicable.
Architecture: static browser app with three files: `index.html` (markup), `style.css` (styles), `app.js` (logic).
Architecture: `app.js` is an IIFE managing game state, rules, DOM rendering, and events.
Architecture: no backend services, databases, or external APIs.
Important DOM IDs: `board`, `status`, `modeText`, `captures`, `events`, `moveBody`, `hardMode`, `newGame`.
Game data: board is 8x8 array of piece objects `{ type, color, hasMoved }`.
Moves: `generatePseudoMoves`, `generateLegalMoves`, and `applyMove` are core rules helpers.
Rendering: `renderBoard`, `renderEvents`, `renderMoves`, `renderStatus` update the UI.
Rules handling: keep `isInCheck`, `isCheckmate`, `isStalemate` consistent with move generation.
Code style: vanilla ES2015+, no frameworks or build tools.
Code style: use `const` by default, `let` only when reassigned.
Code style: prefer pure helper functions and small utilities over inline logic.
Code style: camelCase for variables/functions, UPPER_SNAKE for constants.
Formatting: 2-space indentation, semicolons, trailing commas in multiline literals.
DOM: query once at top-level and reuse cached elements.
State: update `state` immutably when possible; clone board before analysis.
Error handling: guard invalid states early; return `null`/`false` rather than throwing.
Comments: add only when rules logic is non-obvious.
External rules: none found (.cursor, CLAUDE, Windsurf, Cline, Goose, Copilot).
