(function installSprites(globalScope) {
  // 16x16 pixel art, one string per row. Palette keys are resolved per side/theme at draw time.
  // o outline, f fill, h highlight, s shade; umpire-only keys are listed in UMPIRE_PALETTE.
  const PIECES = {
    P: [
      '................',
      '................',
      '................',
      '.......oo.......',
      '......ohfo......',
      '.....ohfffo.....',
      '.....offffo.....',
      '......offo......',
      '......ohfo......',
      '.....ohffso.....',
      '.....offfso.....',
      '....ohfffsso....',
      '...ohffffffso...',
      '...oooooooooo...',
      '..ohfffffffsso..',
      '..oooooooooooo..',
    ],
    R: [
      '................',
      '...oo.oooo.oo...',
      '...ofooffoofo...',
      '...ohffhfffso...',
      '...oooooooooo...',
      '....ohfffsso....',
      '....ohfffsso....',
      '....ohfffsso....',
      '....ohfffsso....',
      '....ohfffsso....',
      '...oooooooooo...',
      '...ohffffffso...',
      '..oooooooooooo..',
      '..ohfffffffsso..',
      '..oooooooooooo..',
      '................',
    ],
    N: [
      '................',
      '.......oo.o.....',
      '......ohfoo.....',
      '.....ohfffo.....',
      '....ohfofffo....',
      '...ohfffffffo...',
      '..ohfffoffffo...',
      '..offo.offffo...',
      '...oo.ohffffo...',
      '.....ohfffsso...',
      '....ohffffsso...',
      '....ohfffffso...',
      '...oooooooooo...',
      '...ohffffffso...',
      '..oooooooooooo..',
      '................',
    ],
    B: [
      '................',
      '.......oo.......',
      '......ohfo......',
      '.......oo.......',
      '......ohfo......',
      '.....ohfofo.....',
      '.....ohffoo.....',
      '.....ohfffo.....',
      '......offo......',
      '......ohfo......',
      '.....oooooo.....',
      '.....ohffso.....',
      '....ohffffso....',
      '...oooooooooo...',
      '..ohfffffffsso..',
      '..oooooooooooo..',
    ],
    Q: [
      '................',
      '..o..o.oo.o..o..',
      '.ofo.ofoofo.ofo.',
      '..ofoofoofoofo..',
      '..ohffffffffso..',
      '...ohfffffsso...',
      '...ohfffffsso...',
      '....ohfffsso....',
      '....ohfffsso....',
      '....oooooooo....',
      '...ohffffffso...',
      '....ohffffso....',
      '...oooooooooo...',
      '..ohfffffffsso..',
      '..oooooooooooo..',
      '................',
    ],
    K: [
      '.......oo.......',
      '......ohfo......',
      '.....oohfoo.....',
      '.....ohfffo.....',
      '.....oohfoo.....',
      '..ooo.ohfo.ooo..',
      '.ohffoohfoohffo.',
      '.ohfffffffffsso.',
      '.ohfffffffffsso.',
      '..ohffffffffso..',
      '...ohffffffso...',
      '...oooooooooo...',
      '...ohffffffso...',
      '..oooooooooooo..',
      '..ohfffffffsso..',
      '..oooooooooooo..',
    ],
  };

  const UMPIRE = {
    idle: [
      '................',
      '.....oooooo.....',
      '....okkkkkko....',
      '...okkkkkkkko...',
      '..oooooooooooo..',
      '....offffffo....',
      '....ofeffefo....',
      '....offffffo....',
      '....offmmffo....',
      '.....offffo.....',
      '...oowwbbwwoo...',
      '..owwbbwwbbwwo..',
      '..owwbbwwbbwwo..',
      '..owwbbwwbbwwo..',
      '..oooooooooooo..',
      '................',
    ],
    talk: [
      '................',
      '.....oooooo.....',
      '....okkkkkko....',
      '...okkkkkkkko...',
      '..oooooooooooo..',
      '....offffffo....',
      '....ofeffefo....',
      '....offffffo....',
      '....offoomfo....',
      '.....offofo.....',
      '...oowwbbwwoo...',
      '..owwbbwwbbwwo..',
      '..owwbbwwbbwwo..',
      '..owwbbwwbbwwo..',
      '..oooooooooooo..',
      '................',
    ],
  };

  const SIDE_PALETTES = {
    w: { o: '#1d1033', f: '#f6efe0', h: '#ffffff', s: '#c9b896' },
    b: { o: '#0c0717', f: '#3b2d5c', h: '#6f5ba3', s: '#241a3b' },
  };

  const UMPIRE_PALETTE = {
    o: '#120a22',
    k: '#2b2b3a',
    f: '#f2c79a',
    e: '#120a22',
    m: '#8a3b3b',
    w: '#f4f4f4',
    b: '#1e1e28',
  };

  const cache = new Map();

  function render(rows, palette, scale = 1) {
    const canvas = document.createElement('canvas');
    canvas.width = rows[0].length * scale;
    canvas.height = rows.length * scale;
    const ctx = canvas.getContext('2d');
    rows.forEach((row, y) => {
      [...row].forEach((key, x) => {
        const color = palette[key];
        if (!color) return;
        ctx.fillStyle = color;
        ctx.fillRect(x * scale, y * scale, scale, scale);
      });
    });
    return canvas.toDataURL();
  }

  function piece(color, type) {
    const key = `piece:${color}${type}`;
    if (!cache.has(key)) cache.set(key, render(PIECES[type], SIDE_PALETTES[color]));
    return cache.get(key);
  }

  function umpire(frame = 'idle') {
    const key = `umpire:${frame}`;
    if (!cache.has(key)) cache.set(key, render(UMPIRE[frame], UMPIRE_PALETTE));
    return cache.get(key);
  }

  // A tileable speckle texture for the fog that covers squares you can't see into.
  function fogTexture(color = '#ffffff') {
    const key = `fog:${color}`;
    if (cache.has(key)) return cache.get(key);
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const n = Math.random();
        if (n < 0.18) {
          ctx.globalAlpha = n < 0.06 ? 0.55 : 0.25;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    const url = canvas.toDataURL();
    cache.set(key, url);
    return url;
  }

  globalScope.BlendChessSprites = {
    PIECES,
    UMPIRE,
    piece,
    umpire,
    fogTexture,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
