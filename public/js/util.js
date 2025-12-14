// =====================
// FILE: public/js/util.js
// =====================
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// ---- RNG plumbing (seedable) ----
// Default source is Math.random; game can swap it per-run.
let _rand01 = () => Math.random();

/** Set the global random source used by rand(). */
export function setRandSource(fn) {
  _rand01 = (typeof fn === "function") ? fn : (() => Math.random());
}

/** Read current random source (rarely needed, but useful for debugging). */
export function getRandSource() {
  return _rand01;
}
// ---- RNG tape (record/playback) ----
export function createTapeRandRecorder(seedStr, tapeOut) {
  const base = createSeededRand(seedStr);
  let count = 0;

  return function () {
    const v = base();
    tapeOut.push(v);
    count++;
    return v;
  };
}

export function createTapeRandPlayer(tapeIn) {
  let i = 0;
  return function () {
    if (i >= tapeIn.length) {
      // Hard fail = you found the exact point determinism diverged
      throw new Error(`RNG tape underrun at index ${i} (tape length ${tapeIn.length}).`);
    }
    return tapeIn[i++];
  };
}
/** Deterministic-friendly rand; uses current global _rand01 source. */
export const rand = (a, b) => a + (b - a) * _rand01();

/**
 * Create a deterministic random() function from a string seed.
 * - hash: xmur3
 * - generator: mulberry32
 */
export function createSeededRand(seedStr) {
  const seed = xmur3(String(seedStr ?? ""))();
  return mulberry32(seed);
}

// xmur3 (string -> 32-bit seed)
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= (h >>> 16)) >>> 0;
  };
}

// mulberry32 (32-bit seed -> [0,1))
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function norm2(x, y) {
  const l = Math.hypot(x, y);
  return (l > 1e-9) ? { x: x / l, y: y / l, len: l } : { x: 0, y: 0, len: 0 };
}

export function approach(cur, tgt, md) {
  const d = tgt - cur;
  if (Math.abs(d) <= md) return tgt;
  return cur + Math.sign(d) * md;
}

export function circleRect(cx, cy, r, rx, ry, rw, rh) {
  const qx = clamp(cx, rx, rx + rw);
  const qy = clamp(cy, ry, ry + rh);
  const dx = cx - qx, dy = cy - qy;
  return (dx * dx + dy * dy) <= r * r;
}

export function circleCircle(ax, ay, ar, bx, by, br) {
  const dx = ax - bx, dy = ay - by, rr = ar + br;
  return (dx * dx + dy * dy) <= rr * rr;
}

export function hexToRgb(h) {
  const s = String(h || "").trim().replace("#", "");
  const m = (s.length === 3) ? (s[0] + s[0] + s[1] + s[1] + s[2] + s[2]) : s;
  const n = parseInt(m, 16);
  if (!Number.isFinite(n)) return { r: 255, g: 255, b: 255 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function lerpC(a, b, t) {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

export function rgb(c, a = 1) {
  return `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;
}

export function shade(c, f) {
  return { r: clamp(c.r * f, 0, 255), g: clamp(c.g * f, 0, 255), b: clamp(c.b * f, 0, 255) };
}

export function hsla(h, s, l, a) {
  h = ((h % 360) + 360) % 360;
  return `hsla(${h},${clamp(s, 0, 100)}%,${clamp(l, 0, 100)}%,${clamp(a, 0, 1)})`;
}

// Cookie helpers (client-side)
export function getCookie(name) {
  const needle = name + "=";
  const parts = document.cookie ? document.cookie.split(";") : [];
  for (const part of parts) {
    const p = part.trim();
    if (p.startsWith(needle)) return p.slice(needle.length);
  }
  return null;
}

export function setCookie(name, value, days) {
  const safe = String(value).replace(/[;\n\r]/g, "");
  const maxAge = Math.max(0, Math.floor(days * 86400));
  document.cookie = `${name}=${encodeURIComponent(safe)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}

export function readJsonCookie(name) {
  const raw = getCookie(name);
  if (!raw) return null;
  try { return JSON.parse(decodeURIComponent(raw)); } catch { return null; }
}

export function writeJsonCookie(name, obj, days) {
  setCookie(name, JSON.stringify(obj), days);
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
