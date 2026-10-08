/* Chameleon — directional hover scramble, per letter.
   Vanilla, offline-safe, no dependencies.
   Spec (from the preview style system): glyph pool "021zrotxinsmopsweknm"
   (uppercase variant "021ZROTXINSOPSEKN" via data-glyphs="upper"),
   800ms in, ~533ms out, hover reveals left-to-right, leave right-to-left.
   Each glyph sits in a fixed-width span measured from the original
   character, so scrambling never changes line length or spacing. */

const GLYPHS_LOWER = "021zrotxinsmopsweknm";
const GLYPHS_UPPER = "021ZROTXINSOPSEKN";
const DURATION_IN = 800;
const DURATION_OUT = Math.round(DURATION_IN / 1.5);
const LTR = 1;
const RTL = -1;

function pick(pool) {
  return pool[(Math.random() * pool.length) | 0];
}

function isKept(ch) {
  return ch === " " || ch === "→";
}

function isRevealed(i, len, count, dir) {
  return dir === LTR ? i < count : i >= len - count;
}

function paint(state, progress) {
  const shown = Math.floor(progress * state.text.length);
  for (let i = 0; i < state.cells.length; i++) {
    if (isKept(state.text[i])) continue;
    state.cells[i].textContent = isRevealed(i, state.text.length, shown, state.dir)
      ? state.text[i]
      : pick(state.pool);
  }
}

function rest(state) {
  for (const cell of state.cells) cell.textContent = cell.dataset.ch;
}

function pinWidths(state) {
  for (const cell of state.cells) {
    cell.style.width = "";
    const w = cell.getBoundingClientRect().width;
    if (w > 0) cell.style.width = w.toFixed(2) + "px";
  }
}

function stop(state) {
  if (state.raf) {
    cancelAnimationFrame(state.raf);
    state.raf = 0;
  }
}

function run(state, dir, ms) {
  stop(state);
  state.dir = dir;
  paint(state, 0);
  if (ms <= 0) {
    rest(state);
    return;
  }
  const t0 = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - t0) / ms);
    if (t >= 1) {
      rest(state);
      state.raf = 0;
      return;
    }
    paint(state, t);
    state.raf = requestAnimationFrame(frame);
  }
  state.raf = requestAnimationFrame(frame);
}

export function initScramble() {
  if (!window.matchMedia("(min-width: 768px) and (hover: hover)").matches) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (window.innerWidth <= 767) return;

  const all = [];

  document.querySelectorAll("[scramble-link]").forEach((link) => {
    const targets = link.hasAttribute("scramble-text")
      ? [link]
      : Array.from(link.querySelectorAll("[scramble-text]"));
    if (targets.length === 0) return;

    const states = targets.map((el) => {
      const text = el.getAttribute("data-text") || el.textContent;
      const pool = el.getAttribute("data-glyphs") === "upper" ? GLYPHS_UPPER : GLYPHS_LOWER;
      el.setAttribute("aria-label", text);
      el.textContent = "";
      const cells = [];
      for (const ch of text) {
        const s = document.createElement("span");
        s.className = "sc-char";
        s.dataset.ch = ch;
        s.textContent = ch;
        el.appendChild(s);
        cells.push(s);
      }
      const state = { el, text, pool, cells, raf: 0, dir: LTR };
      all.push(state);
      return state;
    });

    requestAnimationFrame(() => states.forEach(pinWidths));
    link.addEventListener("mouseenter", () => states.forEach((s) => run(s, LTR, DURATION_IN)));
    link.addEventListener("mouseleave", () => states.forEach((s) => run(s, RTL, DURATION_OUT)));
  });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => all.forEach(pinWidths));
  }

  let timer = 0;
  window.addEventListener("resize", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => all.forEach((s) => { if (!s.raf) pinWidths(s); }), 200);
  });
}
