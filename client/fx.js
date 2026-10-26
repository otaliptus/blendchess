(function installFx(globalScope) {
  const reducedMotion = globalScope.matchMedia && globalScope.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let canvas = null;
  let ctx = null;
  let particles = [];
  let running = false;
  let enabled = true;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'fx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    const resize = () => {
      canvas.width = Math.ceil(globalScope.innerWidth / 3);
      canvas.height = Math.ceil(globalScope.innerHeight / 3);
    };
    resize();
    globalScope.addEventListener('resize', resize);
  }

  // Particles live on a canvas at 1/3 resolution, scaled up with nearest-neighbour: chunky pixels for free.
  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles = particles.filter((p) => p.life > 0);
    for (const p of particles) {
      p.vy += p.gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 1;
      if (p.life < 12 && p.life % 2 === 0) continue; // blink out
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    if (particles.length) {
      requestAnimationFrame(tick);
    } else {
      running = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function spawn(list) {
    if (!enabled || reducedMotion) return;
    ensureCanvas();
    particles.push(...list);
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  }

  function centerOf(element) {
    const rect = element.getBoundingClientRect();
    return { x: (rect.left + rect.width / 2) / 3, y: (rect.top + rect.height / 2) / 3 };
  }

  function burst(element, colors, count = 28, power = 2.4) {
    if (!element) return;
    const { x, y } = centerOf(element);
    const list = [];
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (0.4 + Math.random()) * power;
      list.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1,
        gravity: 0.12,
        size: Math.random() < 0.3 ? 2 : 1,
        life: 30 + Math.floor(Math.random() * 25),
        color: colors[i % colors.length],
      });
    }
    spawn(list);
  }

  function confetti(colors) {
    const width = globalScope.innerWidth / 3;
    const list = [];
    for (let i = 0; i < 140; i += 1) {
      list.push({
        x: Math.random() * width,
        y: -10 - Math.random() * 60,
        vx: (Math.random() - 0.5) * 0.8,
        vy: Math.random() * 1.2,
        gravity: 0.03,
        size: Math.random() < 0.4 ? 2 : 1,
        life: 140 + Math.floor(Math.random() * 80),
        color: colors[i % colors.length],
      });
    }
    spawn(list);
  }

  function rain(colors) {
    const width = globalScope.innerWidth / 3;
    const list = [];
    for (let i = 0; i < 70; i += 1) {
      list.push({
        x: Math.random() * width,
        y: -Math.random() * 80,
        vx: 0,
        vy: 1.5 + Math.random(),
        gravity: 0.02,
        size: 1,
        life: 120,
        color: colors[i % colors.length],
      });
    }
    spawn(list);
  }

  function retrigger(element, className) {
    if (!element) return;
    element.classList.remove(className);
    void element.offsetWidth; // restart the CSS animation
    element.classList.add(className);
    element.addEventListener('animationend', () => element.classList.remove(className), { once: true });
  }

  function shake(element, strong = false) {
    if (!enabled || reducedMotion) return;
    retrigger(element, strong ? 'fx-shake-strong' : 'fx-shake');
  }

  let bannerTimer = null;
  function banner(text, tone = 'info', duration = 1100) {
    let el = document.getElementById('fxBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fxBanner';
      el.className = 'fx-banner';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'assertive');
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.dataset.tone = tone;
    el.style.animationDuration = `${duration}ms`;
    retrigger(el, 'show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  function flash(tone = 'bad') {
    if (!enabled || reducedMotion) return;
    let el = document.getElementById('fxFlash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fxFlash';
      el.className = 'fx-flash';
      document.body.appendChild(el);
    }
    el.dataset.tone = tone;
    retrigger(el, 'show');
  }

  // Types text into an element a few characters per frame; returns a cancel function.
  function typewriter(element, text, { speed = 2, onTick = null, onDone = null } = {}) {
    let index = 0;
    let cancelled = false;
    if (reducedMotion || !enabled) {
      element.textContent = text;
      if (onDone) onDone();
      return () => {};
    }
    element.textContent = '';
    const step = () => {
      if (cancelled) return;
      index = Math.min(text.length, index + speed);
      element.textContent = text.slice(0, index);
      if (onTick && index % 4 === 0) onTick();
      if (index < text.length) requestAnimationFrame(step);
      else if (onDone) onDone();
    };
    requestAnimationFrame(step);
    return () => {
      cancelled = true;
      element.textContent = text;
    };
  }

  globalScope.BlendChessFx = {
    burst,
    confetti,
    rain,
    shake,
    banner,
    flash,
    typewriter,
    retrigger,
    setEnabled(on) {
      enabled = Boolean(on);
    },
    get reducedMotion() {
      return reducedMotion;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
