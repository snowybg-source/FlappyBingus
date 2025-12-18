// =====================
// FILE: public/js/game.js
// =====================
import {
  clamp, lerp, rand, norm2, approach,
  circleRect, circleCircle,
  hexToRgb, lerpC, rgb, shade, hsla
} from "./util.js";
import { ACTIONS, humanizeBind } from "./keybinds.js";

// NEW: orb pickup SFX (pitch shifts by combo)
import { sfxOrbBoop, sfxPerfectNice } from "./audio.js";


const STATE = Object.freeze({ MENU: 0, PLAY: 1, OVER: 2 });

class Pipe {
  constructor(x, y, w, h, vx, vy) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.vx = vx; this.vy = vy;
    this.entered = false;
    this.scored = false;
  }
  cx() { return this.x + this.w * 0.5; }
  cy() { return this.y + this.h * 0.5; }

  // ADD W,H params
  update(dt, mul = 1, W = 0, H = 0) {
    this.x += this.vx * dt * mul;
    this.y += this.vy * dt * mul;

    if (!this.entered) {
      // Mark entered once it overlaps the screen bounds
      if (this.x + this.w >= 0 && this.x <= W && this.y + this.h >= 0 && this.y <= H) {
        this.entered = true;
      }
    }
  }

  off(W, H, m) {
    return (this.x > W + m) || (this.x + this.w < -m) || (this.y > H + m) || (this.y + this.h < -m);
  }
}

class Gate {
  constructor(axis, pos, v, gapCenter, gapHalf, thick) {
    this.axis = axis; this.pos = pos; this.prev = pos; this.v = v;
    this.gapCenter = gapCenter; this.gapHalf = gapHalf; this.thick = thick;
    this.entered = false;
    this.cleared = false;
  }
  update(dt, W, H) {
    this.prev = this.pos;
    this.pos += this.v * dt;
    if (!this.entered) {
      if (this.axis === "x") {
        if (this.pos + this.thick * 0.5 >= 0 && this.pos - this.thick * 0.5 <= W) this.entered = true;
      } else {
        if (this.pos + this.thick * 0.5 >= 0 && this.pos - this.thick * 0.5 <= H) this.entered = true;
      }
    }
  }
  crossed(playerAxis) {
    if (this.cleared || !this.entered) return false;
    if (this.v > 0) return (this.prev < playerAxis && this.pos >= playerAxis);
    if (this.v < 0) return (this.prev > playerAxis && this.pos <= playerAxis);
    return false;
  }
  off(W, H, m) { return this.axis === "x" ? (this.pos < -m || this.pos > W + m) : (this.pos < -m || this.pos > H + m); }
}

class Orb {
  constructor(x, y, vx, vy, r, life) {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy;
    this.r = r; this.life = life; this.max = life;
    this.ph = rand(0, Math.PI * 2);
  }
  update(dt, W, H) {
    this.life -= dt;
    this.ph += dt * 2.2;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const pad = this.r + 4;
    if (this.x < pad) { this.x = pad; this.vx = Math.abs(this.vx); }
    if (this.x > W - pad) { this.x = W - pad; this.vx = -Math.abs(this.vx); }
    if (this.y < pad) { this.y = pad; this.vy = Math.abs(this.vy); }
    if (this.y > H - pad) { this.y = H - pad; this.vy = -Math.abs(this.vy); }
  }
  dead() { return this.life <= 0; }
}

class Part {
  constructor(x, y, vx, vy, life, size, color, add) {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy;
    this.life = life; this.max = life; this.size = size;
    this.color = color; this.add = add;
    this.drag = 0;
  }
  update(dt) {
    this.life -= dt;
    if (this.life <= 0) return;
    if (this.drag > 0) {
      const d = Math.exp(-this.drag * dt);
      this.vx *= d; this.vy *= d;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }
  draw(ctx) {
    if (this.life <= 0) return;
    const t = clamp(this.life / this.max, 0, 1);
    const a = t * t;
    ctx.save();
    if (this.add) ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = a;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, Math.max(0.7, this.size * (0.6 + 0.6 * (1 - t))), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

class FloatText {
  constructor(txt, x, y, color) {
    this.txt = txt; this.x = x; this.y = y;
    this.vx = rand(-18, 18); this.vy = rand(-90, -55);
    this.life = 0.9; this.max = 0.9;
    this.color = color || "rgba(255,255,255,.95)";
    this.size = 18;
  }
  update(dt) {
    this.life -= dt;
    if (this.life <= 0) return;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const d = Math.exp(-2.7 * dt);
    this.vx *= d; this.vy *= d;
  }
  draw(ctx) {
    if (this.life <= 0) return;
    const t = clamp(this.life / this.max, 0, 1), a = t * t;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `900 ${this.size}px system-ui,-apple-system,Segoe UI,Roboto,sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = 14; ctx.shadowOffsetY = 2;
    ctx.fillStyle = this.color;
    ctx.fillText(this.txt, this.x, this.y);
    ctx.restore();
  }
}

export class Game {
  constructor({ canvas, ctx, config, playerImg, input, getTrailId, getBinds, onGameOver }) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.cfg = config;
    this.playerImg = playerImg;
    this.input = input;
    this.getTrailId = getTrailId || (() => "classic");
    this.getBinds = getBinds || (() => ({}));
    this.onGameOver = onGameOver || (() => {});

    this.state = STATE.MENU;

    this.W = 1; this.H = 1; this.DPR = 1;

    this.bgDots = [];

    this.player = {
      x: 0, y: 0, vx: 0, vy: 0,
      w: 48, h: 48, r: 18,
      lastX: 0, lastY: -1,
      invT: 0,
      dashT: 0, dashVX: 0, dashVY: 0
    };

    this.pipes = [];
    this.gates = [];
    this.orbs = [];
    this.parts = [];
    this.floats = [];

    this.score = 0;
    this.timeAlive = 0;

    this.pipeT = 0;
    this.specialT = 1.6;
    this.orbT = 1.0;

    this.combo = 0;
    this.comboBreakFlash = 0;
    this.comboSparkAcc = 0;

    this.perfectT = 0;
    this.perfectMax = 0;

    this.slowField = null; // {x,y,r,fac,t,tm}

    this.cds = { dash: 0, phase: 0, teleport: 0, slowField: 0 };

    // trail emission
    this.trailAcc = 0;
    this.trailHue = 0;

    // NEW: allow main.js to disable SFX during replay/export if desired
    this.audioEnabled = true;
  }

  // NEW: toggle game SFX without touching music
  setAudioEnabled(on) {
    this.audioEnabled = !!on;
  }

  // NEW: orb pickup sound, pitched by combo
  _orbPickupSfx() {
    if (!this.audioEnabled) return;
    // combo already incremented by the time we call this
    sfxOrbBoop(this.combo | 0);
  }
    _perfectNiceSfx() {
    if (!this.audioEnabled) return;
    sfxPerfectNice();
  }


  resizeToWindow() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);

    this.canvas.style.width = cssW + "px";
    this.canvas.style.height = cssH + "px";
    this.canvas.width = Math.floor(cssW * dpr);
    this.canvas.height = Math.floor(cssH * dpr);

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;

    this.DPR = dpr;
    this.W = cssW;
    this.H = cssH;

    this._computePlayerSize();
    this._initBackground();
  }

  setStateMenu() {
    this.state = STATE.MENU;
    this._resetRun(false);
  }

  startRun() {
    this.state = STATE.PLAY;
    this._resetRun(true);
  }

  restartRun() {
    this.startRun();
  }

  handleAction(actionId) {
    if (this.state !== STATE.PLAY) return;
    this._useSkill(actionId);
  }

  _resetRun(clearScore) {
    this.pipes = [];
    this.gates = [];
    this.orbs = [];
    this.parts = [];
    this.floats = [];

    if (clearScore) this.score = 0;
    this.timeAlive = 0;

    this.pipeT = 0;
    this.specialT = 1.6;
    this.orbT = rand(this.cfg.catalysts.orbs.intervalMin, this.cfg.catalysts.orbs.intervalMax);

    this.combo = 0;
    this.comboBreakFlash = 0;
    this.comboSparkAcc = 0;

    this.perfectT = 0;
    this.perfectMax = 0;

    this.slowField = null;
    this.cds = { dash: 0, phase: 0, teleport: 0, slowField: 0 };

    this.trailAcc = 0;
    this.trailHue = 0;

    this._resetPlayer();
  }

  _resetPlayer() {
    const p = this.player;
    p.x = this.W * 0.5;
    p.y = this.H * 0.5;
    p.vx = 0; p.vy = 0;
    p.invT = 0;
    p.dashT = 0;
    p.lastX = 0; p.lastY = -1;
  }

  _computePlayerSize() {
    const p = this.player;
    const base = Math.min(this.W, this.H);
    const target = clamp(base * this.cfg.player.sizeScale, this.cfg.player.sizeMin, this.cfg.player.sizeMax);
    const iw = this.playerImg.naturalWidth || 1;
    const ih = this.playerImg.naturalHeight || 1;
    p.w = target;
    p.h = target * (ih / iw);
    p.r = Math.min(p.w, p.h) * this.cfg.player.radiusScale;
  }

  _initBackground() {
    this.bgDots.length = 0;
    const n = Math.floor(clamp((this.W * this.H) / 11000, 80, 220));
    for (let i = 0; i < n; i++) {
      // IMPORTANT: visuals only -> do NOT use seeded rand()
      this.bgDots.push({
        x: Math.random() * this.W,
        y: Math.random() * this.H,
        r: 0.8 + Math.random() * (2.2 - 0.8),
        s: 4 + Math.random() * (22 - 4)
      });
    }
  }

  _margin() {
    return clamp(Math.min(this.W, this.H) * 0.25, 110, 240);
  }

  _difficulty01() {
    const t = this.timeAlive, s = this.score;
    const tc = Math.max(1e-3, Number(this.cfg.pipes.difficulty.timeToMax) || 38);
    const sc = Math.max(1e-3, Number(this.cfg.pipes.difficulty.scoreToMax) || 120);
    const mt = clamp(Number(this.cfg.pipes.difficulty.mixTime) || 0.55, 0, 1);
    const ms = clamp(Number(this.cfg.pipes.difficulty.mixScore) || 0.45, 0, 1);
    const dT = 1 - Math.exp(-(t / tc));
    const dS = 1 - Math.exp(-(s / sc));
    return clamp(mt * dT + ms * dS, 0, 1);
  }

  _spawnInterval() {
    const d = this._difficulty01();
    const si = this.cfg.pipes.spawnInterval;
    return clamp(lerp(si.start, si.end, d), si.min, si.max);
  }

  _pipeSpeed() {
    const d = this._difficulty01();
    return lerp(this.cfg.pipes.speed.start, this.cfg.pipes.speed.end, d);
  }

  _thickness() {
    const base = Math.min(this.W, this.H), th = this.cfg.pipes.thickness;
    return clamp(base * th.scale, th.min, th.max);
  }

  _gapSize() {
    const d = this._difficulty01(), base = Math.min(this.W, this.H), g = this.cfg.pipes.gap;
    return clamp(lerp(base * g.startScale, base * g.endScale, d), g.min, g.max);
  }

  _pipeColor() {
    const d = this._difficulty01(), col = this.cfg.pipes.colors;
    const g = hexToRgb(col.green), b = hexToRgb(col.blue), y = hexToRgb(col.yellow), r = hexToRgb(col.red);
    if (d < 0.33) return lerpC(g, b, d / 0.33);
    if (d < 0.66) return lerpC(b, y, (d - 0.33) / 0.33);
    return lerpC(y, r, (d - 0.66) / 0.34);
  }

  _spawnSinglePipe(opts = {}) {
    const th = this._thickness();
    const len = clamp(th * rand(3.0, 6.5), th * 2.6, Math.max(this.W, this.H) * 0.55);
    const spd = (opts.speed != null) ? opts.speed : this._pipeSpeed();
    const side = (typeof opts.side === "number") ? opts.side : ((rand(0, 4)) | 0);

    let x = 0, y = 0, vx = 0, vy = 0, pw = 0, ph = 0;
    if (side === 0) { pw = th; ph = len; x = -pw - 12; y = rand(-ph * 0.15, this.H - ph * 0.85); vx = spd; vy = rand(-spd * 0.28, spd * 0.28); }
    if (side === 1) { pw = th; ph = len; x = this.W + 12; y = rand(-ph * 0.15, this.H - ph * 0.85); vx = -spd; vy = rand(-spd * 0.28, spd * 0.28); }
    if (side === 2) { pw = len; ph = th; x = rand(-pw * 0.15, this.W - pw * 0.85); y = -ph - 12; vx = rand(-spd * 0.28, spd * 0.28); vy = spd; }
    if (side === 3) { pw = len; ph = th; x = rand(-pw * 0.15, this.W - pw * 0.85); y = this.H + 12; vx = rand(-spd * 0.28, spd * 0.28); vy = -spd; }

    if (opts.aimAtPlayer) {
      const px = this.player.x, py = this.player.y;
      const cx = (side === 0) ? (-th * 0.5) : (side === 1) ? (this.W + th * 0.5) : rand(0, this.W);
      const cy = (side === 2) ? (-th * 0.5) : (side === 3) ? (this.H + th * 0.5) : rand(0, this.H);
      const d0 = norm2(px - cx, py - cy);
      const spread = (opts.spreadRad != null) ? opts.spreadRad : rand(-0.22, 0.22);
      const cs = Math.cos(spread), sn = Math.sin(spread);
      const ux = d0.x * cs - d0.y * sn, uy = d0.x * sn + d0.y * cs;
      vx = ux * spd; vy = uy * spd;
      if (side === 0) { x = -pw - 14; y = clamp(cy - ph * 0.5, -ph, this.H + ph); }
      if (side === 1) { x = this.W + 14; y = clamp(cy - ph * 0.5, -ph, this.H + ph); }
      if (side === 2) { y = -ph - 14; x = clamp(cx - pw * 0.5, -pw, this.W + pw); }
      if (side === 3) { y = this.H + 14; x = clamp(cx - pw * 0.5, -pw, this.W + pw); }
    }

    this.pipes.push(new Pipe(x, y, pw, ph, vx, vy));
  }

  _spawnWall(opts = {}) {
    const th = this._thickness();
    const spd = (opts.speed != null) ? opts.speed : (this._pipeSpeed() * 0.95);
    const gap = (opts.gap != null) ? opts.gap : this._gapSize();
    const side = (typeof opts.side === "number") ? opts.side : ((rand(0, 4)) | 0);
    const pad = Math.max(18, this.player.r * 1.1);

    if (side === 0 || side === 1) {
      const gc = rand(pad + gap * 0.5, this.H - (pad + gap * 0.5));
      const top = gc - gap * 0.5, bot = gc + gap * 0.5;
      const topLen = clamp(top, 10, this.H), botLen = clamp(this.H - bot, 10, this.H);
      const sx = (side === 0) ? (-th - 16) : (this.W + 16);
      const vx = (side === 0) ? spd : -spd;
      if (topLen > 10) this.pipes.push(new Pipe(sx, 0, th, topLen, vx, 0));
      if (botLen > 10) this.pipes.push(new Pipe(sx, bot, th, botLen, vx, 0));
      this.gates.push(new Gate("x", sx + th * 0.5, vx, gc, gap * 0.5, th));
    } else {
      const gc = rand(pad + gap * 0.5, this.W - (pad + gap * 0.5));
      const left = gc - gap * 0.5, right = gc + gap * 0.5;
      const leftLen = clamp(left, 10, this.W), rightLen = clamp(this.W - right, 10, this.W);
      const sy = (side === 2) ? (-th - 16) : (this.H + 16);
      const vy = (side === 2) ? spd : -spd;
      if (leftLen > 10) this.pipes.push(new Pipe(0, sy, leftLen, th, 0, vy));
      if (rightLen > 10) this.pipes.push(new Pipe(right, sy, rightLen, th, 0, vy));
      this.gates.push(new Gate("y", sy + th * 0.5, vy, gc, gap * 0.5, th));
    }
  }

  _spawnBurst() {
    const d = this._difficulty01();
    const side = (rand(0, 4)) | 0;
    const count = Math.floor(lerp(5, 8, d));
    const spd = this._pipeSpeed() * lerp(0.92, 1.12, d);
    const arc = lerp(0.65, 0.95, d);
    for (let i = 0; i < count; i++) {
      const t = (count === 1) ? 0.5 : i / (count - 1);
      const spread = (t - 0.5) * arc;
      this._spawnSinglePipe({ side, speed: spd, aimAtPlayer: true, spreadRad: spread });
    }
  }

  _spawnCrossfire() {
    const d = this._difficulty01();
    const spd = this._pipeSpeed() * lerp(0.95, 1.10, d);
    this._spawnSinglePipe({ side: 0, speed: spd, aimAtPlayer: true, spreadRad: rand(-0.1, 0.1) });
    this._spawnSinglePipe({ side: 1, speed: spd, aimAtPlayer: true, spreadRad: rand(-0.1, 0.1) });
    this._spawnSinglePipe({ side: 2, speed: spd, aimAtPlayer: true, spreadRad: rand(-0.1, 0.1) });
    this._spawnSinglePipe({ side: 3, speed: spd, aimAtPlayer: true, spreadRad: rand(-0.1, 0.1) });
  }

  _spawnOrb() {
    const o = this.cfg.catalysts.orbs;
    if (!o.enabled) return;
    if (this.orbs.length >= o.maxOnScreen) return;

    const r = clamp(Number(o.radius) || 12, 6, 40);
    const life = clamp(Number(o.lifetime) || 10, 1, 60);
    const safe = clamp(Number(o.safeDistance) || 120, 0, 800);

    let x = this.W * 0.5, y = this.H * 0.5;
    for (let i = 0; i < 18; i++) {
      const px = rand(r + 10, this.W - r - 10), py = rand(r + 10, this.H - r - 10);
      if (Math.hypot(px - this.player.x, py - this.player.y) >= (this.player.r + r + safe)) { x = px; y = py; break; }
    }

    const sp = rand(o.driftSpeedMin, o.driftSpeedMax);
    const a = rand(0, Math.PI * 2);
    this.orbs.push(new Orb(x, y, Math.cos(a) * sp, Math.sin(a) * sp, r, life));
  }

  _orbPoints(comboNow) {
    const base = Math.max(0, Number(this.cfg.scoring.orbBase) || 0);
    const bonus = Math.max(0, Number(this.cfg.scoring.orbComboBonus) || 0);
    return Math.round(base + bonus * Math.max(0, comboNow - 1));
  }

  _breakCombo(x, y) {
    if (this.combo > 0) this.floats.push(new FloatText("COMBO BROKE", x, y, "rgba(255,90,90,.95)"));
    this.combo = 0;
    this.comboBreakFlash = 0.35;
  }

  _tickCooldowns(dt) {
    this.cds.dash = Math.max(0, this.cds.dash - dt);
    this.cds.phase = Math.max(0, this.cds.phase - dt);
    this.cds.teleport = Math.max(0, this.cds.teleport - dt);
    this.cds.slowField = Math.max(0, this.cds.slowField - dt);
  }

  _useSkill(name) {
    if (!this.cfg.skills[name]) return;
    if (this.cds[name] > 0) return;

    const p = this.player;

    if (name === "dash") {
      const d = this.cfg.skills.dash;
      const dur = clamp(Number(d.duration) || 0, 0, 1.2);

      // dash direction = current move input or last direction
      const mv = this.input.getMove();
      const n = norm2(mv.dx, mv.dy);
      const dx = (n.len > 0) ? n.x : p.lastX;
      const dy = (n.len > 0) ? n.y : p.lastY;
      const nn = norm2(dx, dy);

      p.dashVX = (nn.len > 0) ? nn.x : 0;
      p.dashVY = (nn.len > 0) ? nn.y : -1;
      p.dashT = dur;

      this.cds.dash = Math.max(0, Number(d.cooldown) || 0);

      for (let i = 0; i < 18; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(40, 260);
        const vx = Math.cos(a) * sp - p.dashVX * 220;
        const vy = Math.sin(a) * sp - p.dashVY * 220;
        const prt = new Part(p.x, p.y, vx, vy, rand(0.18, 0.34), rand(1.0, 2.2), "rgba(255,255,255,.80)", true);
        prt.drag = 9.5;
        this.parts.push(prt);
      }
    }

    if (name === "phase") {
      const ph = this.cfg.skills.phase;
      const dur = clamp(Number(ph.duration) || 0, 0, 2.0);
      p.invT = Math.max(p.invT, dur);
      this.cds.phase = Math.max(0, Number(ph.cooldown) || 0);
      this.floats.push(new FloatText("PHASE", p.x, p.y - p.r * 1.6, "rgba(160,220,255,.95)"));
    }

    if (name === "teleport") {
      const t = this.cfg.skills.teleport;

      const ed = clamp(Number(t.effectDuration) || 0.35, 0.1, 1.2);
      const burst = Math.floor(clamp(Number(t.burstParticles) || 0, 0, 240));

      const cur = (this.input && this.input.cursor) ? this.input.cursor : this.cursor;
      if (!cur || !cur.has) return;

      const pad = p.r + 2;
      const ox = p.x, oy = p.y;

      // --- KEY FIX: map cursor -> world space ---
      const cw = this.canvas?.width || this.W;
      const ch = this.canvas?.height || this.H;

      const sx = (cw > 0) ? (this.W / cw) : 1;
      const sy = (ch > 0) ? (this.H / ch) : 1;

      const tx = cur.x * sx;
      const ty = cur.y * sy;

      const nx = clamp(tx, pad, this.W - pad);
      const ny = clamp(ty, pad, this.H - pad);
      // --- END FIX ---

      for (let i = 0; i < burst; i++) {
        const a0 = rand(0, Math.PI * 2), sp0 = rand(80, 420);
        const p0 = new Part(
          ox, oy,
          Math.cos(a0) * sp0, Math.sin(a0) * sp0,
          rand(0.22, 0.50), rand(1.0, 2.2),
          "rgba(210,170,255,.92)", true
        );
        p0.drag = 7.5;
        this.parts.push(p0);

        const a1 = rand(0, Math.PI * 2), sp1 = rand(80, 420);
        const p1 = new Part(
          nx, ny,
          Math.cos(a1) * sp1, Math.sin(a1) * sp1,
          rand(0.22, 0.55), rand(1.0, 2.4),
          "rgba(255,255,255,.82)", true
        );
        p1.drag = 7.0;
        this.parts.push(p1);
      }

      p.x = nx; p.y = ny;
      p.vx *= 0.25; p.vy *= 0.25;

      this.cds.teleport = Math.max(0, Number(t.cooldown) || 0);
      this.floats.push(new FloatText("TELEPORT", p.x, p.y - p.r * 1.7, "rgba(230,200,255,.95)"));

      for (let i = 0; i < 26; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(40, 160);
        const prt = new Part(
          nx, ny,
          Math.cos(a) * sp, Math.sin(a) * sp,
          ed, rand(0.9, 1.7),
          "rgba(255,255,255,.45)", true
        );
        prt.drag = 10;
        this.parts.push(prt);
      }
    }

    if (name === "slowField") {
      const s = this.cfg.skills.slowField;

      const dur = clamp(Number(s.duration) || 0, 0, 8.0);
      const rad = clamp(Number(s.radius) || 0, 40, 900);
      const fac = clamp(Number(s.slowFactor) || 0.6, 0.10, 1.0);

      this.slowField = { x: p.x, y: p.y, r: rad, fac, t: dur, tm: dur };
      this.cds.slowField = Math.max(0, Number(s.cooldown) || 0);
      this.floats.push(new FloatText("SLOW FIELD", p.x, p.y - p.r * 1.8, "rgba(120,210,255,.95)"));
    }
  }

  _updatePlayer(dt) {
    const p = this.player;

    if (p.invT > 0) p.invT = Math.max(0, p.invT - dt);
    if (p.dashT > 0) p.dashT = Math.max(0, p.dashT - dt);

    const mv = this.input.getMove();
    const n = norm2(mv.dx, mv.dy);
    if (n.len > 0) { p.lastX = n.x; p.lastY = n.y; }

    if (p.dashT > 0) {
      if (n.len > 0) { p.dashVX = n.x; p.dashVY = n.y; }
      const dashSpeed = Math.max(0, Number(this.cfg.skills.dash.speed) || 0);
      p.vx = p.dashVX * dashSpeed;
      p.vy = p.dashVY * dashSpeed;
    } else {
      const maxS = Number(this.cfg.player.maxSpeed) || 0;
      const accel = Number(this.cfg.player.accel) || 0;
      const fr = Number(this.cfg.player.friction) || 0;

      const tvx = n.x * maxS, tvy = n.y * maxS;
      p.vx = approach(p.vx, tvx, accel * dt);
      p.vy = approach(p.vy, tvy, accel * dt);

      if (n.len === 0) {
        const damp = Math.exp(-fr * dt);
        p.vx *= damp; p.vy *= damp;
      }
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const pad = p.r + 2;
    p.x = clamp(p.x, pad, this.W - pad);
    p.y = clamp(p.y, pad, this.H - pad);
  }

  _trailStyle(id) {
    if (id === "rainbow") return { rate: 95, life: [0.18, 0.34], size: [7, 10], speed: [35, 170], drag: 10.5, add: true };
    if (id === "gothic") return { rate: 78, life: [0.20, 0.40], size: [7, 10], speed: [30, 150], drag: 9.5, add: true };
    return { rate: 55, life: [0.18, 0.32], size: [0.8, 2.0], speed: [25, 120], drag: 11.5, add: true };
  }

  _emitTrail(dt) {
    const id = this.getTrailId();
    const st = this._trailStyle(id);

    this.trailHue = (this.trailHue + dt * 220) % 360;
    this.trailAcc += dt * st.rate;

    const n = this.trailAcc | 0;
    this.trailAcc -= n;

    const p = this.player;

    const v = norm2(p.vx, p.vy);
    const backX = (v.len > 12) ? -v.x : -p.lastX;
    const backY = (v.len > 12) ? -v.y : -p.lastY;
    const bx = p.x + backX * p.r * 0.95;
    const by = p.y + backY * p.r * 0.95;

    for (let i = 0; i < n; i++) {
      const jitter = rand(0, Math.PI * 2);
      const jx = Math.cos(jitter) * rand(0, p.r * 0.35);
      const jy = Math.sin(jitter) * rand(0, p.r * 0.35);

      const sp = rand(st.speed[0], st.speed[1]);
      const a = rand(0, Math.PI * 2);
      const vx = backX * sp + Math.cos(a) * sp * 0.55;
      const vy = backY * sp + Math.sin(a) * sp * 0.55;

      const life = rand(st.life[0], st.life[1]);
      const size = rand(st.size[0], st.size[1]);

      let color = "rgba(140,220,255,.62)";
      if (id === "rainbow") {
        const h = (this.trailHue + i * 11) % 360;
        color = hsla(h, 100, 70, 0.85);
      } else if (id === "gothic") {
        const ink = rand(0, 1) < 0.16;
        color = ink ? "rgba(0,0,0,.55)" : "rgba(170,90,255,.72)";
      }

      const prt = new Part(bx + jx, by + jy, vx, vy, life, size, color, st.add);
      prt.drag = st.drag;
      this.parts.push(prt);
    }
  }

  update(dt) {
    // MENU can have subtle background drift; OVER freezes everything.
    if (this.state === STATE.OVER) return;

    // background drift
    for (const p of this.bgDots) {
      p.y += p.s * dt;
      if (p.y > this.H + 10) {
        p.y = -10;
        p.x = Math.random() * this.W; // visuals only -> not seeded
      }
    }

    if (this.state !== STATE.PLAY) return;

    this.timeAlive += dt;
    this._tickCooldowns(dt);

    if (this.comboBreakFlash > 0) this.comboBreakFlash = Math.max(0, this.comboBreakFlash - dt);
    if (this.perfectT > 0) this.perfectT = Math.max(0, this.perfectT - dt);

    if (this.slowField) {
      this.slowField.t = Math.max(0, this.slowField.t - dt);
      if (this.slowField.t <= 0) this.slowField = null;
    }

    this._updatePlayer(dt);
    this._emitTrail(dt);

    // combo sparkles
    const sparkleAt = Number(this.cfg.ui.comboBar.sparkleAt) || 9999;
    if (this.combo >= sparkleAt) {
      const rate = Math.max(0, Number(this.cfg.ui.comboBar.sparkleRate) || 0);
      this.comboSparkAcc += dt * rate;
      const n = this.comboSparkAcc | 0;
      this.comboSparkAcc -= n;

      const ui = this._skillUI();
      for (let i = 0; i < n; i++) {
        const px = rand(ui.barX, ui.barX + ui.barW);
        const py = rand(ui.barY - 8, ui.barY + ui.barH + 8);
        const a = rand(0, Math.PI * 2), sp = rand(20, 90);
        const prt = new Part(px, py, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.18, 0.35), rand(0.9, 1.7), "rgba(255,255,255,.7)", true);
        prt.drag = 10.5;
        this.parts.push(prt);
      }
    } else {
      this.comboSparkAcc = 0;
    }

    // spawn pipes
    this.pipeT -= dt;
    while (this.pipeT <= 0) {
      this.pipeT += this._spawnInterval();

      const d = this._difficulty01();
      const r = rand(0, 1);
      const wall = this.cfg.pipes.patternWeights.wall;
      const aimed = this.cfg.pipes.patternWeights.aimed;
      const wallChance = lerp(wall[0], wall[1], d);
      const aimedChance = lerp(aimed[0], aimed[1], d);

      if (r < wallChance) this._spawnWall({ side: (rand(0, 4)) | 0, gap: this._gapSize(), speed: this._pipeSpeed() * 0.95 });
      else if (r < wallChance + aimedChance) this._spawnSinglePipe({ side: (rand(0, 4)) | 0, aimAtPlayer: true, speed: this._pipeSpeed() });
      else this._spawnSinglePipe({ side: (rand(0, 4)) | 0, aimAtPlayer: false, speed: this._pipeSpeed() });
    }

    // special patterns
    this.specialT -= dt;
    if (this.specialT <= 0) {
      const r = rand(0, 1);
      if (r < 0.48) this._spawnBurst();
      else if (r < 0.78) this._spawnCrossfire();
      else this._spawnWall({ side: (rand(0, 4)) | 0, gap: this._gapSize(), speed: this._pipeSpeed() * 1.05 });

      const d = this._difficulty01();
      const sp = this.cfg.pipes.special;
      this.specialT = lerp(sp.startCadence, sp.endCadence, d) + rand(sp.jitterMin, sp.jitterMax);
    }

    // spawn orbs
    const o = this.cfg.catalysts.orbs;
    if (o.enabled) {
      this.orbT -= dt;
      if (this.orbT <= 0) {
        this._spawnOrb();
        const a = Math.min(o.intervalMin, o.intervalMax), b = Math.max(o.intervalMin, o.intervalMax);
        this.orbT = rand(a, b);
      }
    }

    // update gates + PERFECT
    for (const g of this.gates) g.update(dt, this.W, this.H);
    if (this.cfg.scoring.perfect.enabled) {
      const bonus = Math.max(0, Number(this.cfg.scoring.perfect.bonus) || 0);
      const wS = clamp(Number(this.cfg.scoring.perfect.windowScale) || 0.075, 0, 1);

      for (const g of this.gates) {
        if (g.cleared) continue;
        const pAxis = (g.axis === "x") ? this.player.x : this.player.y;
        if (g.crossed(pAxis)) {
          g.cleared = true;
          const perp = (g.axis === "x") ? this.player.y : this.player.x;
          const dist = Math.abs(perp - g.gapCenter);
          const thresh = Math.max(3, g.gapHalf * wS) * 1.10; // NEW: 5% leniency
if (dist <= thresh) {
  this._perfectNiceSfx();
            this.score += bonus;
            const fd = clamp(Number(this.cfg.scoring.perfect.flashDuration) || 0.55, 0.15, 2.0);
            this.perfectT = fd; this.perfectMax = fd;
            this.floats.push(new FloatText(`+${bonus}`, this.player.x, this.player.y - this.player.r * 2.0, "rgba(255,255,255,.95)"));

            for (let k = 0; k < 28; k++) {
              const a = rand(0, Math.PI * 2), sp = rand(60, 320);
              const prt = new Part(this.player.x, this.player.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.20, 0.45), rand(1.0, 2.2), "rgba(255,255,255,.85)", true);
              prt.drag = 8.5;
              this.parts.push(prt);
            }
          }
        }
      }
    }

    // update pipes
    for (const p of this.pipes) {
      let mul = 1;
      if (this.slowField) {
        const dx = p.cx() - this.slowField.x, dy = p.cy() - this.slowField.y;
        if ((dx * dx + dy * dy) <= this.slowField.r * this.slowField.r) mul = this.slowField.fac;
      }
      p.update(dt, mul, this.W, this.H);
    }

    // orbs + despawn breaks combo
    let expired = false;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      this.orbs[i].update(dt, this.W, this.H);
      if (this.orbs[i].dead()) { this.orbs.splice(i, 1); expired = true; }
    }
    if (expired) {
      const ui = this._skillUI();
      this._breakCombo(ui.barX + ui.barW * 0.5, ui.barY - 10);
    }

    // orb pickup
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const ob = this.orbs[i];
      if (circleCircle(this.player.x, this.player.y, this.player.r, ob.x, ob.y, ob.r)) {
        this.orbs.splice(i, 1);

        const maxC = Math.max(1, Number(this.cfg.scoring.orbComboMax) || 30);
        this.combo = Math.min(maxC, this.combo + 1);

        // NEW: play boop AFTER combo increments (so pitch rises with combo)
        this._orbPickupSfx();

        const pts = this._orbPoints(this.combo);
        this.score += pts;

        const col = (this.combo >= (Number(this.cfg.ui.comboBar.glowAt) || 9999))
          ? "rgba(255,255,255,.98)"
          : "rgba(120,210,255,.95)";
        this.floats.push(new FloatText(`+${pts}`, ob.x, ob.y, col));

        for (let k = 0; k < 18; k++) {
          const a = rand(0, Math.PI * 2), sp = rand(40, 240);
          const prt = new Part(ob.x, ob.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.18, 0.38), rand(1.0, 2.0), "rgba(255,255,255,.7)", true);
          prt.drag = 10;
          this.parts.push(prt);
        }
      }
    }

    // collision (phase = invuln)
    if (this.player.invT <= 0) {
      for (const p of this.pipes) {
        if (circleRect(this.player.x, this.player.y, this.player.r, p.x, p.y, p.w, p.h)) {
          this.state = STATE.OVER; // freeze
          this.onGameOver(this.score | 0);
          return;
        }
      }
    }

    // pipe removal + base score
    const m = this._margin();
    for (let i = this.pipes.length - 1; i >= 0; i--) {
      const p = this.pipes[i];
      if (p.off(this.W, this.H, m)) {
        if (!p.scored) {
          p.scored = true;
          this.score += Math.max(0, Number(this.cfg.scoring.pipeDodge) || 0);
        }
        this.pipes.splice(i, 1);
      }
    }
    for (let i = this.gates.length - 1; i >= 0; i--) if (this.gates[i].off(this.W, this.H, m)) this.gates.splice(i, 1);

    // fx update/cleanup
    for (const p of this.parts) p.update(dt);
    for (const t of this.floats) t.update(dt);
    for (let i = this.parts.length - 1; i >= 0; i--) if (this.parts[i].life <= 0) this.parts.splice(i, 1);
    for (let i = this.floats.length - 1; i >= 0; i--) if (this.floats[i].life <= 0) this.floats.splice(i, 1);

    // caps
    if (this.pipes.length > 280) this.pipes.splice(0, this.pipes.length - 280);
    if (this.parts.length > 1100) this.parts.splice(0, this.parts.length - 1100);
    if (this.floats.length > 80) this.floats.splice(0, this.floats.length - 80);
  }

  render() {
    const ctx = this.ctx;

    // background
    ctx.fillStyle = "#07101a";
    ctx.fillRect(0, 0, this.W, this.H);

    // vignette
    const vg = ctx.createRadialGradient(this.W * 0.5, this.H * 0.45, Math.min(this.W, this.H) * 0.12, this.W * 0.5, this.H * 0.5, Math.max(this.W, this.H) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,.44)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.W, this.H);

    // dots
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = "rgba(255,255,255,.20)";
    for (const p of this.bgDots) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // world
    const pc = this._pipeColor();
    for (const p of this.pipes) this._drawPipe(p, pc);
    for (const o of this.orbs) this._drawOrb(o);

    for (const p of this.parts) p.draw(ctx);
    for (const t of this.floats) t.draw(ctx);

    this._drawPlayer();

    if (this.state === STATE.PLAY) {
      this._drawHUD();
      this._drawPerfectFlash();
    }
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    const rr = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  _drawPipe(p, base) {
    const ctx = this.ctx;
    const edge = shade(base, 0.72), hi = shade(base, 1.12);

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.45)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;

    const g = (p.w >= p.h)
      ? ctx.createLinearGradient(p.x, p.y, p.x + p.w, p.y)
      : ctx.createLinearGradient(p.x, p.y, p.x, p.y + p.h);
    g.addColorStop(0, rgb(edge, 0.95));
    g.addColorStop(0.45, rgb(base, 0.92));
    g.addColorStop(1, rgb(hi, 0.95));

    ctx.fillStyle = g;
    ctx.fillRect(p.x, p.y, p.w, p.h);

    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,.10)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x + 0.75, p.y + 0.75, p.w - 1.5, p.h - 1.5);

    ctx.globalAlpha = 0.08;
    ctx.fillStyle = "rgba(255,255,255,.9)";
    const step = 10;
    if (p.w >= p.h) {
      for (let sx = p.x + 6; sx < p.x + p.w; sx += step) ctx.fillRect(sx, p.y + 2, 2, p.h - 4);
    } else {
      for (let sy = p.y + 6; sy < p.y + p.h; sy += step) ctx.fillRect(p.x + 2, sy, p.w - 4, 2);
    }

    ctx.restore();
  }

_drawOrb(o) {
  const ctx = this.ctx;

  // t: 1 = just spawned, 0 = expiring
  const t = clamp(o.life / o.max, 0, 1);

  // p: 0 = just spawned, 1 = expiring
  const p = 1 - t;

  // Optional curve for a more "extreme" ramp (hits yellow sooner, then red harder)
  const pr = Math.pow(p, 0.75);

  const pulse = 0.88 + 0.12 * Math.sin(o.ph);
  const r = o.r * pulse;

  // Green -> Yellow -> Red (piecewise lerp)
  const cGreen = hexToRgb("#57FF6A");
  const cYellow = hexToRgb("#FFE45C");
  const cRed = hexToRgb("#FF4B4B");

  let core;
  if (pr < 0.5) {
    core = lerpC(cGreen, cYellow, pr / 0.5);
  } else {
    core = lerpC(cYellow, cRed, (pr - 0.5) / 0.5);
  }

  ctx.save();

  // Glow matches the core color
  ctx.shadowColor = `rgba(${core.r|0},${core.g|0},${core.b|0},.50)`;
  ctx.shadowBlur = 18;

  // Outer shell
  ctx.fillStyle = "rgba(255,255,255,.88)";
  ctx.beginPath();
  ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
  ctx.fill();

  // Inner core (traffic-light color)
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = rgb(core, 0.85);
  ctx.beginPath();
  ctx.arc(o.x, o.y, r * 0.55, 0, Math.PI * 2);
  ctx.fill();

  // Outer ring fades as life runs out
  ctx.globalAlpha = 0.38 * t;
  ctx.strokeStyle = "rgba(255,255,255,.75)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(o.x, o.y, r * 1.35, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}




  _drawPlayer() {
    const ctx = this.ctx;
    const p = this.player;

    ctx.save();
    ctx.shadowBlur = 18;
    ctx.shadowColor = (p.invT > 0) ? "rgba(160,220,255,.35)" : "rgba(120,210,255,.22)";

    if (this.playerImg && this.playerImg.naturalWidth > 0) {
      ctx.drawImage(this.playerImg, p.x - p.w * 0.5, p.y - p.h * 0.5, p.w, p.h);
    } else {
      ctx.fillStyle = "rgba(120,210,255,.92)";
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,.55)";
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(2, p.r * 0.18), 0, Math.PI * 2); ctx.fill();
    }

    // Phase i-frame indicator: ring (no blink)
    if (p.invT > 0) {
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = "rgba(160,220,255,.95)";
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 1.28, 0, Math.PI * 2); ctx.stroke();

      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = "rgba(255,255,255,.85)";
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 1.06, -Math.PI * 0.15, Math.PI * 0.15); ctx.stroke();
    }

    ctx.restore();
  }

  _drawPerfectFlash() {
    if (this.perfectT <= 0) return;
    const ctx = this.ctx;

    const t = clamp(this.perfectT / Math.max(1e-3, this.perfectMax), 0, 1);
    const a = (1 - t) * (1 - t);

    ctx.save();
    ctx.globalAlpha = clamp(a * 0.95, 0, 1);
    ctx.font = "900 56px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,.60)";
    ctx.shadowBlur = 22; ctx.shadowOffsetY = 4;
    ctx.fillStyle = "rgba(255,255,255,.95)";
    ctx.fillText("PERFECT", this.W * 0.5, 18);

    ctx.globalAlpha = clamp(a * 0.25, 0, 1);
    ctx.fillStyle = "rgba(120,210,255,.95)";
    ctx.fillText("PERFECT", this.W * 0.5 + 2, 18);
    ctx.restore();
  }

  _skillUI() {
    const base = Math.min(this.W, this.H);
    const size = clamp(base * 0.070, 46, 64);
    const gap = Math.round(size * 0.14);
    const pad = 16;
    const x0 = pad;
    const y0 = this.H - pad - size;
    const totalW = 4 * size + 3 * gap;
    const barH = 10;
    const barX = x0;
    const barY = y0 - 16 - barH;
    return { x0, y0, size, gap, totalW, barX, barY, barW: totalW, barH };
  }

  _drawHUD() {
    const ctx = this.ctx;

    // score (top-left)
    ctx.save();
    ctx.font = "900 18px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 2;
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.fillText(`Score: ${this.score | 0}`, 14, 14);

    // intensity (top-right)
    ctx.textAlign = "right";
    ctx.globalAlpha = 0.70;
    ctx.font = "800 13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    ctx.fillText(`Intensity: ${Math.round(this._difficulty01() * 100)}%`, this.W - 14, 14);
    ctx.restore();

    // slow field ring
    if (this.slowField) {
      const t = clamp(this.slowField.t / Math.max(1e-3, this.slowField.tm), 0, 1);
      const a = 0.22 + 0.18 * (1 - t);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.strokeStyle = "rgba(120,210,255,.75)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(this.slowField.x, this.slowField.y, this.slowField.r, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = a * 0.35;
      ctx.strokeStyle = "rgba(255,255,255,.60)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(this.slowField.x, this.slowField.y, this.slowField.r * 0.75, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    this._drawSkillBar();
  }

  _drawSkillIcon(skill, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (skill === "dash") {
      ctx.moveTo(-r * 0.8, -r * 0.25);
      ctx.lineTo(r * 0.35, -r * 0.25);
      ctx.lineTo(r * 0.35, -r * 0.6);
      ctx.lineTo(r * 0.9, 0);
      ctx.lineTo(r * 0.35, r * 0.6);
      ctx.lineTo(r * 0.35, r * 0.25);
      ctx.lineTo(-r * 0.8, r * 0.25);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (skill === "phase") {
      ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2); ctx.stroke();
    } else if (skill === "teleport") {
      ctx.beginPath(); ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-r * 1.2, 0); ctx.lineTo(-r * 0.6, 0);
      ctx.moveTo(r * 0.6, 0); ctx.lineTo(r * 1.2, 0);
      ctx.moveTo(0, -r * 1.2); ctx.lineTo(0, -r * 0.6);
      ctx.moveTo(0, r * 0.6); ctx.lineTo(0, r * 1.2);
      ctx.stroke();
    } else if (skill === "slowField") {
      ctx.beginPath(); ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r * 0.55, -Math.PI * 0.25, Math.PI * 0.25); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r * 0.55, Math.PI * 0.75, Math.PI * 1.25); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  _drawSkillBar() {
    const ctx = this.ctx;
    const ui = this._skillUI();

    const comboMax = Math.max(1, Number(this.cfg.scoring.orbComboMax) || 30);
    const fill = clamp(this.combo / comboMax, 0, 1);

    // combo bar
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.50)";
    ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;

    ctx.fillStyle = "rgba(255,255,255,.08)";
    this._roundRect(ui.barX, ui.barY, ui.barW, ui.barH, 999); ctx.fill();

    const fillW = ui.barW * fill;
    if (fillW > 0.5) {
      const glowAt = Number(this.cfg.ui.comboBar.glowAt) || 9999;
      const sparkleAt = Number(this.cfg.ui.comboBar.sparkleAt) || 9999;
      ctx.shadowBlur = (this.combo >= glowAt) ? 18 : 8;
      ctx.shadowColor = (this.combo >= glowAt) ? "rgba(255,255,255,.25)" : "rgba(120,210,255,.20)";
      const g = ctx.createLinearGradient(ui.barX, ui.barY, ui.barX + ui.barW, ui.barY);
      g.addColorStop(0, "rgba(120,210,255,.70)");
      g.addColorStop(0.6, (this.combo >= sparkleAt) ? "rgba(255,255,255,.75)" : "rgba(255,255,255,.45)");
      g.addColorStop(1, "rgba(255,255,255,.22)");
      ctx.fillStyle = g;
      this._roundRect(ui.barX, ui.barY, fillW, ui.barH, 999); ctx.fill();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.85;
    ctx.font = "800 12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(255,255,255,.70)";
    ctx.fillText(`COMBO ${this.combo}`, ui.barX, ui.barY - 2);

    if (this.comboBreakFlash > 0) {
      const a = clamp(this.comboBreakFlash / 0.35, 0, 1);
      ctx.globalAlpha = a * 0.55;
      ctx.strokeStyle = "rgba(255,90,90,.85)";
      ctx.lineWidth = 2;
      this._roundRect(ui.barX - 2, ui.barY - 2, ui.barW + 4, ui.barH + 4, 999); ctx.stroke();
    }

    // skill slots (fixed order per ACTIONS)
    const binds = this.getBinds();
    for (let i = 0; i < ACTIONS.length; i++) {
      const action = ACTIONS[i].id;
      const x = ui.x0 + i * (ui.size + ui.gap);
      const y = ui.y0;

      ctx.globalAlpha = 1;
      ctx.shadowColor = "rgba(0,0,0,.50)";
      ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
      ctx.fillStyle = "rgba(255,255,255,.08)";
      this._roundRect(x, y, ui.size, ui.size, 12); ctx.fill();

      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,.16)";
      ctx.lineWidth = 1.5;
      this._roundRect(x, y, ui.size, ui.size, 12); ctx.stroke();

      // key label (humanized bind)
      const keyLabel = humanizeBind(binds[action]);
      ctx.fillStyle = "rgba(255,255,255,.75)";
      ctx.font = "900 11px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(keyLabel, x + 8, y + 7);

      const rem = Math.max(0, this.cds[action] || 0);
      const max = Math.max(0, Number(this.cfg.skills[action]?.cooldown) || 0);
      const ready = rem <= 1e-6;

      // icon
      ctx.save();
      ctx.translate(x + ui.size * 0.55, y + ui.size * 0.60);
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = ready ? "rgba(255,255,255,.78)" : "rgba(255,255,255,.35)";
      ctx.fillStyle = ready ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.06)";
      this._drawSkillIcon(action, ui.size * 0.22);
      ctx.restore();

      // cooldown overlay
      if (max > 1e-6 && rem > 0) {
        const frac = clamp(rem / max, 0, 1);
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = "rgba(0,0,0,.55)";
        this._roundRect(x, y + ui.size * (1 - frac), ui.size, ui.size * frac, 12); ctx.fill();

        ctx.globalAlpha = 0.85;
        ctx.fillStyle = "rgba(255,255,255,.85)";
        ctx.font = "900 12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(rem.toFixed(1), x + ui.size * 0.5, y + ui.size * 0.58);
      }
    }

    ctx.restore();
  }
}
