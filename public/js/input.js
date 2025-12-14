// =====================
// FILE: public/js/input.js
// =====================
import { ACTIONS, bindToken } from "./keybinds.js";

export class Input {
  constructor(canvas, getBinds, onAction) {
    this.canvas = canvas;
    this.getBinds = getBinds;
    this.onAction = onAction || (() => {});
    this.keys = Object.create(null);
    this.cursor = { x: 0, y: 0, has: false };
  }

  setOnAction(fn) { this.onAction = fn || (() => {}); }
  snapshot() {
    // keep it minimal; replay only needs movement + cursor
    return {
      move: this.getMove(),
      cursor: { x: this.cursor.x, y: this.cursor.y, has: this.cursor.has }
    };
  }

  install() {
    // Cursor
const updateCursor = (e) => {
  const r = this.canvas.getBoundingClientRect();

  // Convert DOM coords -> canvas internal coords (handles devicePixelRatio / CSS scaling)
  const sx = this.canvas.width / r.width;
  const sy = this.canvas.height / r.height;

  // IMPORTANT: write to the same object teleport uses
  const c = (this.input && this.input.cursor) ? this.input.cursor : this.cursor;

  c.x = (e.clientX - r.left) * sx;
  c.y = (e.clientY - r.top) * sy;
  c.has = true;
};

    function updateCursorFromEvent(e, canvas, cursor) {
  const rect = canvas.getBoundingClientRect();

  // Convert DOM pixels -> canvas internal pixels
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const c = this.cursor;

  
  cursor.x = (e.clientX - rect.left) * sx;
  cursor.y = (e.clientY - rect.top) * sy;
  cursor.has = true;
}

    window.addEventListener("pointermove", updateCursor, { passive: true });
    window.addEventListener("pointerdown", (e) => {
      updateCursor(e);

      // Find if this mouse button is bound to an action
      const binds = this.getBinds();
      const tok = `m:${e.button}`;
      for (const a of ACTIONS) {
        if (bindToken(binds[a.id]) === tok) {
          e.preventDefault();
          this.onAction(a.id, { type: "mouse", button: e.button, event: e });
          break;
        }
      }
      window.focus();
    }, { passive: false });

    // Prevent context menu on the playfield
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Keyboard
    const isTypingField = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      return false;
    };

    window.addEventListener("keydown", (e) => {
      if (isTypingField()) return;

      this.keys[e.code] = true;

      const binds = this.getBinds();
      // prevent scroll for movement + any bound key
      const maybePrevent = () => {
        // WASD always
        if (e.code === "KeyW" || e.code === "KeyA" || e.code === "KeyS" || e.code === "KeyD") return true;
        // keys bound to actions
        for (const a of ACTIONS) {
          const b = binds[a.id];
          if (b && b.type === "key" && b.code === e.code) return true;
        }
        return false;
      };
      if (maybePrevent()) e.preventDefault();

      if (!e.repeat) {
        for (const a of ACTIONS) {
          const b = binds[a.id];
          if (b && b.type === "key" && b.code === e.code) {
            this.onAction(a.id, { type: "key", code: e.code, event: e });
            break;
          }
        }
      }
    }, { passive: false });

    window.addEventListener("keyup", (e) => {
      this.keys[e.code] = false;
    });
  }

  reset() {
    this.keys = Object.create(null);
  }

  getMove() {
    let dx = 0, dy = 0;
    if (this.keys.KeyW) dy -= 1;
    if (this.keys.KeyS) dy += 1;
    if (this.keys.KeyA) dx -= 1;
    if (this.keys.KeyD) dx += 1;
    return { dx, dy };
  }
}
