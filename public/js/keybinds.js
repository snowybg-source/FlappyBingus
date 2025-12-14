// =====================
// FILE: public/js/keybinds.js
// =====================
import { readJsonCookie, writeJsonCookie } from "./util.js";

export const ACTIONS = Object.freeze([
  { id: "dash", label: "Dash" },
  { id: "phase", label: "Invulnerability" },
  { id: "teleport", label: "Teleport" },
  { id: "slowField", label: "Slow Field" }
]);

export const DEFAULT_KEYBINDS = Object.freeze({
  dash: { type: "key", code: "Space" },
  phase: { type: "key", code: "KeyQ" },
  teleport: { type: "mouse", button: 0 },   // Left Mouse
  slowField: { type: "key", code: "KeyE" }
});

// Guest persistence cookie for binds (small + safe)
const BINDS_COOKIE = "sprinkles";

export function cloneBinds(binds) {
  return JSON.parse(JSON.stringify(binds));
}

export function bindToken(b) {
  if (!b) return "";
  if (b.type === "key") return `k:${b.code}`;
  if (b.type === "mouse") return `m:${b.button}`;
  return "";
}

export function bindEquals(a, b) {
  return bindToken(a) === bindToken(b);
}

export function normalizeBind(b) {
  if (!b || typeof b !== "object") return null;
  if (b.type === "key") {
    const code = String(b.code || "").trim();
    if (!code || code.length > 32) return null;
    if (!/^[A-Za-z0-9]+$/.test(code)) return null;
    return { type: "key", code };
  }
  if (b.type === "mouse") {
    const btn = Number(b.button);
    if (!Number.isInteger(btn) || btn < 0 || btn > 2) return null;
    return { type: "mouse", button: btn };
  }
  return null;
}

export function mergeBinds(base, incoming) {
  const out = {};
  const src = (incoming && typeof incoming === "object") ? incoming : {};
  for (const a of Object.keys(base)) out[a] = normalizeBind(src[a]) || base[a];
  return out;
}

export function humanizeBind(b) {
  if (!b) return "Unbound";
  if (b.type === "mouse") {
    if (b.button === 0) return "LMB";
    if (b.button === 1) return "MMB";
    if (b.button === 2) return "RMB";
    return `Mouse ${b.button}`;
  }
  if (b.type === "key") {
    const c = String(b.code || "");
    if (c === "Space") return "Space";
    if (c.startsWith("Key") && c.length === 4) return c.slice(3);
    if (c.startsWith("Digit") && c.length === 6) return c.slice(5);
    if (c.startsWith("Arrow")) return c.replace("Arrow", "←/↑/→/↓".includes(c) ? c : "Arrow ");
    // common nice names
    if (c === "ShiftLeft" || c === "ShiftRight") return "Shift";
    if (c === "ControlLeft" || c === "ControlRight") return "Ctrl";
    if (c === "AltLeft" || c === "AltRight") return "Alt";
    return c;
  }
  return "Unbound";
}

export function keyEventToBind(e) {
  return { type: "key", code: e.code };
}

export function pointerEventToBind(e) {
  return { type: "mouse", button: e.button };
}

/**
 * Apply a rebind. If the new bind is already used by another action, swap them.
 * This keeps all actions always bound.
 */
export function applyRebindWithSwap(binds, actionId, newBind) {
  const nb = normalizeBind(newBind);
  if (!nb) return { binds, changed: false, swappedWith: null };

  const out = cloneBinds(binds);
  const actions = Object.keys(out);

  const targetToken = bindToken(nb);
  let other = null;
  for (const a of actions) {
    if (a === actionId) continue;
    if (bindToken(out[a]) === targetToken) { other = a; break; }
  }

  const prev = out[actionId];
  out[actionId] = nb;

  if (other) out[other] = prev;

  return { binds: out, changed: true, swappedWith: other };
}

export function loadGuestBinds() {
  const raw = readJsonCookie(BINDS_COOKIE);
  return mergeBinds(DEFAULT_KEYBINDS, raw);
}

export function saveGuestBinds(binds) {
  // keep cookie small
  writeJsonCookie(BINDS_COOKIE, binds, 3650);
}
