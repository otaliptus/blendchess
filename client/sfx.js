(function installSfx(globalScope) {
  // Tiny chiptune synth on WebAudio: square/triangle/saw voices plus a noise channel.
  let ctx = null;
  let master = null;
  let sfxBus = null;
  let musicBus = null;
  let noiseBuffer = null;
  let soundOn = true;
  let musicOn = false;
  let musicTimer = null;
  let musicStep = 0;
  let nextNoteTime = 0;

  function ensure() {
    if (ctx) return ctx;
    const Ctx = globalScope.AudioContext || globalScope.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = soundOn ? 1 : 0;
    sfxBus.connect(master);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.32;
    musicBus.connect(master);

    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function unlock() {
    const audio = ensure();
    if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
  }

  function tone({ freq, to = null, start = 0, dur = 0.08, type = 'square', gain = 0.08, bus = null }) {
    const audio = ensure();
    if (!audio) return;
    const t0 = audio.currentTime + start;
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp);
    amp.connect(bus || sfxBus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise({ start = 0, dur = 0.15, gain = 0.12, filter = 1800, sweepTo = null }) {
    const audio = ensure();
    if (!audio) return;
    const t0 = audio.currentTime + start;
    const src = audio.createBufferSource();
    src.buffer = noiseBuffer;
    const lp = audio.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(filter, t0);
    if (sweepTo) lp.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    const amp = audio.createGain();
    amp.gain.setValueAtTime(gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp);
    lp.connect(amp);
    amp.connect(sfxBus);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  function arpeggio(notes, { step = 0.07, type = 'square', gain = 0.07, dur = 0.09 } = {}) {
    notes.forEach((freq, index) => tone({ freq, start: index * step, dur, type, gain }));
  }

  const N = {
    C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77, C6: 1046.5,
    A2: 110.0, C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0,
  };

  const effects = {
    click: () => tone({ freq: 880, dur: 0.03, gain: 0.04 }),
    hover: () => tone({ freq: 1320, dur: 0.015, gain: 0.015 }),
    select: () => tone({ freq: 660, to: 990, dur: 0.06, gain: 0.05 }),
    deselect: () => tone({ freq: 700, to: 420, dur: 0.05, gain: 0.04 }),
    move: () => {
      noise({ dur: 0.05, gain: 0.08, filter: 900 });
      tone({ freq: 196, dur: 0.06, type: 'triangle', gain: 0.12 });
    },
    opponentMove: () => {
      tone({ freq: 392, dur: 0.07, type: 'triangle', gain: 0.07 });
      tone({ freq: 523, start: 0.08, dur: 0.09, type: 'triangle', gain: 0.07 });
    },
    capture: () => {
      noise({ dur: 0.22, gain: 0.16, filter: 3000, sweepTo: 300 });
      tone({ freq: 880, to: 1760, dur: 0.12, gain: 0.06 });
    },
    lost: () => {
      noise({ dur: 0.35, gain: 0.18, filter: 1600, sweepTo: 120 });
      tone({ freq: 330, to: 82, dur: 0.38, type: 'sawtooth', gain: 0.07 });
    },
    illegal: () => {
      tone({ freq: 110, dur: 0.12, type: 'square', gain: 0.08 });
      tone({ freq: 104, start: 0.13, dur: 0.18, type: 'square', gain: 0.08 });
    },
    opponentIllegal: () => tone({ freq: 220, to: 330, dur: 0.12, type: 'triangle', gain: 0.05 }),
    forfeit: () => {
      arpeggio([N.E5, N.C5, N.A4, N.E4], { step: 0.08, type: 'sawtooth', gain: 0.05, dur: 0.1 });
      noise({ start: 0.32, dur: 0.2, gain: 0.08, filter: 800 });
    },
    check: () => {
      for (let i = 0; i < 3; i += 1) {
        tone({ freq: 988, start: i * 0.16, dur: 0.07, gain: 0.07 });
        tone({ freq: 740, start: i * 0.16 + 0.08, dur: 0.07, gain: 0.07 });
      }
    },
    drawOffer: () => arpeggio([N.G4, N.C5, N.E5], { step: 0.09, type: 'triangle', gain: 0.07 }),
    join: () => arpeggio([N.C5, N.E5, N.G5, N.C6], { step: 0.06, gain: 0.05 }),
    leave: () => arpeggio([N.G5, N.E5, N.C5], { step: 0.07, gain: 0.04 }),
    error: () => tone({ freq: 150, to: 90, dur: 0.25, type: 'sawtooth', gain: 0.06 }),
    start: () => {
      arpeggio([N.C5, N.E5, N.G5, N.C6, N.G5, N.C6], { step: 0.07, gain: 0.06 });
      tone({ freq: N.C3, dur: 0.45, type: 'triangle', gain: 0.12 });
    },
    win: () => {
      const melody = [N.C5, N.E5, N.G5, N.C6, N.G5, N.C6];
      melody.forEach((freq, i) => tone({ freq, start: i * 0.11, dur: i === melody.length - 1 ? 0.5 : 0.1, gain: 0.07 }));
      [N.C3, N.G3, N.C3].forEach((freq, i) => tone({ freq, start: i * 0.22, dur: 0.2, type: 'triangle', gain: 0.12 }));
    },
    lose: () => {
      [N.G4, N.F4, N.E4, N.D4, N.C4].forEach((freq, i) => tone({ freq, start: i * 0.16, dur: 0.15, type: 'triangle', gain: 0.09 }));
      tone({ freq: N.C3, to: N.A2, start: 0.8, dur: 0.6, type: 'sawtooth', gain: 0.05 });
    },
    draw: () => arpeggio([N.E5, N.G4, N.E5, N.G4], { step: 0.12, type: 'triangle', gain: 0.07 }),
    type: () => tone({ freq: 1400 + Math.random() * 300, dur: 0.012, gain: 0.012 }),
    reveal: () => noise({ dur: 0.9, gain: 0.07, filter: 400, sweepTo: 6000 }),
  };

  function play(name) {
    if (!soundOn || !effects[name]) return;
    unlock();
    try {
      effects[name]();
    } catch {
      // audio is a nicety; never let it break the game
    }
  }

  // A small looping tune: Am - F - C - G, triangle bass and a quiet square arpeggio.
  const CHORDS = [
    { bass: N.A2, notes: [N.A4, N.C5, N.E5] },
    { bass: N.F3 / 2, notes: [N.F4, N.A4, N.C5] },
    { bass: N.C3, notes: [N.E4, N.G4, N.C5] },
    { bass: N.G3 / 2, notes: [N.D4, N.G4, N.B4] },
  ];
  const STEP_SECONDS = 60 / 104 / 4;

  function scheduleMusic() {
    const audio = ensure();
    if (!audio) return;
    while (nextNoteTime < audio.currentTime + 0.25) {
      const chord = CHORDS[Math.floor(musicStep / 16) % CHORDS.length];
      const stepInBar = musicStep % 16;
      const at = nextNoteTime - audio.currentTime;
      if (stepInBar % 4 === 0) tone({ freq: chord.bass, start: at, dur: STEP_SECONDS * 3, type: 'triangle', gain: 0.14, bus: musicBus });
      if (stepInBar % 2 === 0) {
        const note = chord.notes[(stepInBar / 2) % chord.notes.length];
        tone({ freq: note * (stepInBar >= 8 ? 2 : 1), start: at, dur: STEP_SECONDS * 0.9, type: 'square', gain: 0.025, bus: musicBus });
      }
      nextNoteTime += STEP_SECONDS;
      musicStep += 1;
    }
  }

  function setMusic(on) {
    musicOn = Boolean(on);
    if (musicTimer) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
    if (!musicOn) return;
    const audio = ensure();
    if (!audio) return;
    unlock();
    nextNoteTime = audio.currentTime + 0.05;
    musicTimer = setInterval(scheduleMusic, 60);
  }

  function setSound(on) {
    soundOn = Boolean(on);
    if (sfxBus) sfxBus.gain.value = soundOn ? 1 : 0;
  }

  globalScope.BlendChessSfx = {
    play,
    unlock,
    setSound,
    setMusic,
    get soundOn() {
      return soundOn;
    },
    get musicOn() {
      return musicOn;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
