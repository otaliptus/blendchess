// Renders the small "how to play" animations in assets/help/ from the game's own sprites.
// Usage: cd tools && npm install && npm run help-gifs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';

const { GIFEncoder } = gifenc;

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.document = {};
require(path.join(root, 'client/sprites.js'));
const { PIECES } = globalThis.BlendChessSprites;

const SQ = 20;
const N = 4;
const SIZE = SQ * N;
const OUT = path.join(root, 'assets/help');

// Arcade palette, matching style.css and client/sprites.js.
const C = {
  light: '#b9a6f0',
  dark: '#7458c8',
  fog: '#e8e0ff',
  hl: '#ffd23f',
  bad: '#ff4f5e',
  dot: '#2a1a55',
  ink: '#07030f',
};
const SIDES = {
  w: { o: '#1d1033', f: '#f6efe0', h: '#ffffff', s: '#c9b896' },
  b: { o: '#0c0717', f: '#3b2d5c', h: '#6f5ba3', s: '#241a3b' },
};

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
const mix = (a, b, t) => {
  const [x, y] = [hex(a), hex(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
};

function createFrame() {
  const pixels = new Array(SIZE * SIZE).fill(C.ink);
  const set = (x, y, color) => {
    if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) pixels[y * SIZE + x] = color;
  };
  const get = (x, y) => pixels[y * SIZE + x];
  const rect = (x, y, w, h, color) => {
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) set(x + i, y + j, color);
  };
  return { pixels, set, get, rect };
}

const squareColor = (r, c) => ((r + c) % 2 ? C.dark : C.light);

function board(frame) {
  for (let r = 0; r < N; r += 1) for (let c = 0; c < N; c += 1) frame.rect(c * SQ, r * SQ, SQ, SQ, squareColor(r, c));
}

function piece(frame, r, c, color, type, fade = 0, dx = 0, dy = 0) {
  PIECES[type].forEach((row, y) => [...row].forEach((key, x) => {
    const paint = SIDES[color][key];
    if (!paint) return;
    const px = c * SQ + 2 + x + dx;
    const py = r * SQ + 2 + y + dy;
    frame.set(px, py, fade ? mix(paint, frame.get(px, py), fade) : paint);
  }));
}

// Deterministic speckle so the fog "drifts" between frames.
function fog(frame, squares, seed, strength = 1) {
  for (const [r, c] of squares) {
    for (let y = 0; y < SQ; y += 1) {
      for (let x = 0; x < SQ; x += 1) {
        const n = Math.abs(Math.sin((c * SQ + x) * 12.9898 + (r * SQ + y) * 78.233 + seed * 3.17) * 43758.5453) % 1;
        if (n < 0.2 * strength) frame.set(c * SQ + x, r * SQ + y, mix(squareColor(r, c), C.fog, n < 0.07 ? 0.65 : 0.35));
      }
    }
  }
}

function outline(frame, r, c, color, width = 2) {
  frame.rect(c * SQ, r * SQ, SQ, width, color);
  frame.rect(c * SQ, r * SQ + SQ - width, SQ, width, color);
  frame.rect(c * SQ, r * SQ, width, SQ, color);
  frame.rect(c * SQ + SQ - width, r * SQ, width, SQ, color);
}

function dot(frame, r, c) {
  frame.rect(c * SQ + 8, r * SQ + 8, 4, 4, C.dot);
}

function dashed(frame, r, c) {
  for (let i = 2; i < SQ - 2; i += 4) {
    frame.rect(c * SQ + i, r * SQ + 2, 2, 2, C.dot);
    frame.rect(c * SQ + i, r * SQ + SQ - 4, 2, 2, C.dot);
    frame.rect(c * SQ + 2, r * SQ + i, 2, 2, C.dot);
    frame.rect(c * SQ + SQ - 4, r * SQ + i, 2, 2, C.dot);
  }
}

function cross(frame, r, c, color = C.bad) {
  for (let i = 3; i < SQ - 3; i += 1) {
    frame.rect(c * SQ + i, r * SQ + i, 2, 2, color);
    frame.rect(c * SQ + SQ - 2 - i, r * SQ + i, 2, 2, color);
  }
}

function tint(frame, r, c, color, t) {
  for (let y = 0; y < SQ; y += 1) {
    for (let x = 0; x < SQ; x += 1) frame.set(c * SQ + x, r * SQ + y, mix(frame.get(c * SQ + x, r * SQ + y), color, t));
  }
}

const QUESTION = ['.oo.', 'o..o', '...o', '..o.', '..o.', '....', '..o.'];
function question(frame, r, c) {
  QUESTION.forEach((row, y) => [...row].forEach((key, x) => {
    if (key === 'o') frame.rect(c * SQ + 6 + x * 2, r * SQ + 3 + y * 2, 2, 2, C.hl);
  }));
}

const allSquares = () => Array.from({ length: N * N }, (_, i) => [Math.floor(i / N), i % N]);
const without = (squares, taken) => squares.filter(([r, c]) => !taken.some(([tr, tc]) => tr === r && tc === c));

function encode(name, frames) {
  const palette = [];
  const index = new Map();
  const gif = GIFEncoder();
  for (const { frame, delay } of frames) {
    const data = new Uint8Array(SIZE * SIZE);
    frame.pixels.forEach((color, i) => {
      if (!index.has(color)) {
        index.set(color, palette.length);
        palette.push(hex(color));
      }
      data[i] = index.get(color);
    });
    if (palette.length > 256) throw new Error(`${name}: too many colours`);
    gif.writeFrame(data, SIZE, SIZE, { palette: palette.concat(Array(256 - palette.length).fill([0, 0, 0])), delay, repeat: 0 });
  }
  gif.finish();
  writeFileSync(path.join(OUT, `${name}.gif`), gif.bytes());
}

// 1. You only see your own pieces.
function fogScene() {
  const mine = [[3, 1, 'K'], [3, 3, 'R'], [2, 2, 'P']];
  const theirs = [[0, 2, 'K'], [1, 0, 'N'], [1, 3, 'P']];
  const foggy = without(allSquares(), mine);
  const frames = [];
  for (let step = 0; step <= 8; step += 1) {
    const frame = createFrame();
    board(frame);
    mine.forEach(([r, c, t]) => piece(frame, r, c, 'w', t));
    const fade = Math.min(1, Math.max(0, (step - 1) / 3));
    if (fade < 1) theirs.forEach(([r, c, t]) => piece(frame, r, c, 'b', t, fade));
    if (step > 0) fog(frame, foggy, step, Math.min(1, step / 3));
    frames.push({ frame, delay: step === 0 ? 1100 : step < 4 ? 160 : 260 });
  }
  encode('fog', frames);
}

// 2. Hints: dots where a move might work, dashed corners for pawn captures to try.
function hintsScene() {
  const mine = [[3, 0, 'R'], [3, 2, 'K'], [2, 3, 'P']];
  const foggy = without(allSquares(), mine);
  const frames = [];
  const base = (seed) => {
    const frame = createFrame();
    board(frame);
    fog(frame, foggy, seed);
    mine.forEach(([r, c, t]) => piece(frame, r, c, 'w', t));
    return frame;
  };
  frames.push({ frame: base(0), delay: 500 });
  let frame = base(1);
  outline(frame, 3, 0, C.hl);
  frames.push({ frame, delay: 300 });
  frame = base(2);
  outline(frame, 3, 0, C.hl);
  [[0, 0], [1, 0], [2, 0], [3, 1]].forEach(([r, c]) => dot(frame, r, c));
  frames.push({ frame, delay: 1300 });
  frame = base(3);
  outline(frame, 2, 3, C.hl);
  dot(frame, 1, 3);
  dashed(frame, 1, 2);
  frames.push({ frame, delay: 1500 });
  encode('hints', frames);
}

// 3. Illegal try: something hidden is in the way. Hard mode would cost the turn.
function illegalScene() {
  const mine = [[3, 0, 'B'], [3, 3, 'K']];
  const foggy = without(allSquares(), mine);
  const frames = [];
  const base = (seed) => {
    const frame = createFrame();
    board(frame);
    fog(frame, foggy, seed);
    piece(frame, 3, 3, 'w', 'K');
    return frame;
  };
  let frame = base(0);
  piece(frame, 3, 0, 'w', 'B');
  outline(frame, 3, 0, C.hl);
  dot(frame, 0, 3);
  frames.push({ frame, delay: 700 });
  for (const [step, delay] of [[6, 70], [12, 70], [18, 70], [24, 90]]) {
    frame = base(step);
    piece(frame, 3, 0, 'w', 'B', 0, step, -step);
    frames.push({ frame, delay });
  }
  for (let blink = 0; blink < 3; blink += 1) {
    frame = base(10 + blink);
    piece(frame, 3, 0, 'w', 'B', 0, 20, -20);
    question(frame, 1, 2);
    if (blink % 2 === 0) {
      frame.rect(0, 0, SIZE, 2, C.bad);
      frame.rect(0, SIZE - 2, SIZE, 2, C.bad);
      frame.rect(0, 0, 2, SIZE, C.bad);
      frame.rect(SIZE - 2, 0, 2, SIZE, C.bad);
    }
    cross(frame, 0, 3);
    frames.push({ frame, delay: 220 });
  }
  frame = base(20);
  piece(frame, 3, 0, 'w', 'B');
  frames.push({ frame, delay: 1000 });
  encode('illegal', frames);
}

// 4. Captures are announced with the square.
function captureScene() {
  const frames = [];
  const base = (seed, withKnight) => {
    const mine = withKnight ? [[2, 1], [3, 3]] : [[3, 3]];
    const frame = createFrame();
    board(frame);
    fog(frame, without(allSquares(), mine), seed);
    piece(frame, 3, 3, 'w', 'K');
    if (withKnight) piece(frame, 2, 1, 'w', 'N');
    return frame;
  };
  frames.push({ frame: base(0, true), delay: 1000 });
  for (let blink = 0; blink < 5; blink += 1) {
    const frame = base(blink + 1, false);
    if (blink % 2 === 0) cross(frame, 2, 1);
    frames.push({ frame, delay: 200 });
  }
  const frame = base(9, false);
  cross(frame, 2, 1);
  frames.push({ frame, delay: 1100 });
  encode('capture', frames);
}

// 5. Check: only you hear it, plus the line it comes from.
function checkScene() {
  const mine = [[3, 1, 'K'], [3, 3, 'R']];
  const foggy = without(allSquares(), mine);
  const frames = [];
  for (let step = 0; step < 8; step += 1) {
    const frame = createFrame();
    board(frame);
    fog(frame, foggy, step);
    if (step > 0) {
      const on = step % 2 === 1;
      tint(frame, 2, 2, C.bad, on ? 0.35 : 0.2);
      tint(frame, 1, 3, C.bad, on ? 0.25 : 0.12);
      if (on) tint(frame, 3, 1, C.bad, 0.55);
      outline(frame, 3, 1, on ? C.bad : C.hl, 3);
    }
    mine.forEach(([r, c, t]) => piece(frame, r, c, 'w', t));
    frames.push({ frame, delay: step === 0 ? 800 : 260 });
  }
  encode('check', frames);
}

mkdirSync(OUT, { recursive: true });
fogScene();
hintsScene();
illegalScene();
captureScene();
checkScene();
console.log(`wrote 5 gifs to ${path.relative(process.cwd(), OUT)}`);
