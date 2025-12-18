// =========================
// FILE: public/js/tutorial.js
// =========================
// Tutorial manager for Flappy Bingus.
//
// Design goals:
// - Introduce ONE mechanic at a time.
// - Auto-retry on failure.
// - Never rely on RNG for tutorial-critical setups.
// - Keep scenarios extremely forgiving and visually guided.

import { clamp, lerp } from "./util.js";
import { ACTIONS, humanizeBind } from "./keybinds.js";

function easeInOutCubic(t) {
  t = clamp(t, 0, 1);
  return (t < 0.5)
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  const paragraphs = String(text || "").split("\n");
  for (const p of paragraphs) {
    const words = p.split(/\s+/g).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = line + " " + words[i];
      if (ctx.measureText(test).width <= maxWidth) line = test;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  }
  return out;
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

// Minimal “duck-typed” Pipe and Gate objects compatible with Game.update().
function makePipeRect({ x, y, w, h, vx, vy }) {
  return {
    x, y, w, h, vx, vy,
    entered: false,
    scored: false,
    cx() { return this.x + this.w * 0.5; },
    cy() { return this.y + this.h * 0.5; },
    update(dt, mul = 1, W = 0, H = 0) {
      this.x += this.vx * dt * mul;
      this.y += this.vy * dt * mul;
      if (!this.entered) {
        if (this.x + this.w >= 0 && this.x <= W && this.y + this.h >= 0 && this.y <= H) {
          this.entered = true;
        }
      }
    },
    off(W, H, m) {
      // Slightly smaller margin for snappier tutorial pacing.
      const mm = Math.min(90, m);
      return (this.x > W + mm) || (this.x + this.w < -mm) || (this.y > H + mm) || (this.y + this.h < -mm);
    }
  };
}

function makeGate(axis, pos, v, gapCenter, gapHalf, thick) {
  return {
    axis,
    pos,
    prev: pos,
    v,
    gapCenter,
    gapHalf,
    thick,
    entered: false,
    cleared: false,
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
    },
    crossed(playerAxis) {
      if (this.cleared || !this.entered) return false;
      if (this.v > 0) return (this.prev < playerAxis && this.pos >= playerAxis);
      if (this.v < 0) return (this.prev > playerAxis && this.pos <= playerAxis);
      return false;
    },
    off(W, H, m) {
      const mm = Math.min(90, m);
      return (this.axis === "x")
        ? (this.pos < -mm || this.pos > W + mm)
        : (this.pos < -mm || this.pos > H + mm);
    }
  };
}

function makeOrb({ x, y, r = 12, life = 8, vx = 0, vy = 0 }) {
  return {
    x, y, vx, vy,
    r,
    life,
    max: life,
    ph: Math.random() * Math.PI * 2, // purely visual
    update(dt, W, H) {
      this.life -= dt;
      this.ph += dt * 2.2;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      // Keep orbs on-screen.
      const pad = this.r + 6;
      if (this.x < pad) this.x = pad;
      if (this.x > W - pad) this.x = W - pad;
      if (this.y < pad) this.y = pad;
      if (this.y > H - pad) this.y = H - pad;
    },
    dead() { return this.life <= 0; }
  };
}

// Public API
export class Tutorial {
  constructor({ game, input, getBinds, onExit }) {
    this.game = game;
    this.input = input;
    this.getBinds = getBinds || (() => ({}));
    this.onExit = onExit || (() => {});

    // Live state
    this.active = false;
    this.pauseSim = false;

    // Action queue (mirrors the live run pipeline in main.js)
    this._pendingActions = [];

    // Step machine
    this._stepIndex = 0;
    this._stepT = 0;

    // Per-step working vars
    this._allowed = new Set();
    this._msgFlashT = 0;
    this._msgFlash = "";

    // Icon intro animation
    this._iconIntro = null; // { skill, t, dur, done }

    // Tracking (generic)
    this._prevCombo = 0;
    this._prevPerfectT = 0;
    this._blockedHintCd = 0;

    // Scenario objects
    this._moveWall = null;
    this._moveTarget = null;

    this._gate = null;

    this._phaseWall = null;
    this._phaseUsed = false;
    this._phasePassed = false;
    this._phaseCelebrateT = 0;

    this._dashUsed = false;
    this._dashTarget = null;
    this._dashCountdownT = 0;
    this._dashNeedReenter = false;
    this._dashReenterArmed = false;
    this._dashWasInZone = false;
    this._dashSuccessDelay = 0;
    this._dashWallsSpawned = 0;

    this._teleTarget = null;
    this._teleUsed = false;

    this._slowUsed = false;
    this._slowBurstSpawned = false;
    this._surviveT = 0;

    // Config overrides (restored on stop)
    this._cfgBackup = null;

    // Meta key handling for tutorial-only flows
    this._boundKeyDown = (e) => {
      if (!this.active) return;
      // Esc: always exit tutorial
      if (e.code === "Escape") {
        e.preventDefault();
        this.stop();
        this.onExit();
      }
      // Enter: if tutorial complete (practice mode), return to menu
      if (this._stepId() === "practice" && e.code === "Enter") {
        e.preventDefault();
        this.stop();
        this.onExit();
      }
    };
  }

  // ----- lifecycle -----
  start() {
    if (this.active) return;
    if (!this.game?.cfg) throw new Error("Tutorial.start(): game.cfg must be loaded first.");

    this.active = true;
    window.addEventListener("keydown", this._boundKeyDown, { passive: false });

    this._backupAndOverrideConfig();

    // Start clean run
    this.game.startRun();
    this._freezeAutoSpawns();
    this._hardClearWorld();

    this._msgFlashT = 0;
    this._msgFlash = "";

    this._stepIndex = 0;
    this._enterStep(0);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.pauseSim = false;

    window.removeEventListener("keydown", this._boundKeyDown, { passive: false });

    this._pendingActions.length = 0;
    this._allowed.clear();
    this._iconIntro = null;

    this._moveWall = null;
    this._moveTarget = null;

    this._gate = null;

    this._phaseWall = null;
    this._teleTarget = null;

    this._slowBurstSpawned = false;

    this._restoreConfig();
  }

  // ----- actions pipeline -----
  enqueueAction(a) {
    if (!this.active) return;
    if (!a || !a.id) return;
    this._pendingActions.push(a);
  }

  drainActions() {
    const out = this._pendingActions.splice(0);
    return out;
  }

  allowAction(actionId) {
    if (!this.active) return true;
    if (!actionId) return false;
    return this._allowed.has(actionId);
  }

  // Call this from main.js right after game.handleAction(actionId).
  // It is the most reliable way to detect “the player used the skill”,
  // especially if tutorial tweaks cooldown values.
  onActionApplied(actionId) {
    if (!this.active) return;
    const sid = this._stepId();
    if ((sid === "skill_phase" || sid === "practice") && actionId === "phase") this._phaseUsed = true;
    if ((sid === "skill_dash" || sid === "practice") && actionId === "dash") this._dashUsed = true;
    if ((sid === "skill_teleport" || sid === "practice") && actionId === "teleport") this._teleUsed = true;
    if ((sid === "skill_slow" || sid === "practice") && actionId === "slowField") this._slowUsed = true;
  }

  // Optional: call this from main.js when a skill is pressed but blocked.
  // This avoids the “nothing happened” confusion.
  notifyBlockedAction(actionId) {
    if (!this.active) return;
    if (!actionId) return;
    if (this._blockedHintCd > 0) return;

    const label = ACTIONS.find(a => a.id === actionId)?.label || "That skill";
    this._flash(`${label} is locked for this step.`);
    this._blockedHintCd = 0.9;
  }

  // Called by main.js when a collision triggers game over.
  handleGameOver() {
    if (!this.active) return;
    // Auto-retry: restart the SAME step.
    this._flash("Try again — you’ve got this.");
    this._restartStep();
  }

  // ----- per-frame update (real dt; UI animations) -----
  frame(dt) {
    if (!this.active) return;
    this._stepT += dt;
    if (this._msgFlashT > 0) this._msgFlashT = Math.max(0, this._msgFlashT - dt);
    if (this._blockedHintCd > 0) this._blockedHintCd = Math.max(0, this._blockedHintCd - dt);

    if (this._iconIntro) {
      this._iconIntro.t += dt;
      if (this._iconIntro.t >= this._iconIntro.dur) {
        this._iconIntro.t = this._iconIntro.dur;
        this._iconIntro.done = true;
      }
      this.pauseSim = true;
    } else {
      this.pauseSim = false;
    }
  }

  // ----- fixed-timestep hooks (simulation dt) -----
  beforeSimTick(dt) {
    if (!this.active) return;

    const sid = this._stepId();

    // Keep the baseline game from injecting random content,
    // EXCEPT in practice mode (where we want a full sandbox).
    if (sid !== "practice") this._freezeAutoSpawns();

    // Ensure the “teaching skill” is always ready when we’re in a skill step,
    // and keep all skills ready in practice mode.
    if (sid === "skill_phase" || sid === "practice") this.game.cds.phase = 0;
    if (sid === "skill_dash" || sid === "practice") this.game.cds.dash = 0;
    if (sid === "skill_teleport" || sid === "practice") this.game.cds.teleport = 0;
    if (sid === "skill_slow" || sid === "practice") this.game.cds.slowField = 0;
  }

  afterSimTick(dt) {
    if (!this.active) return;

    const sid = this._stepId();
    // Step logic runs *after* the game tick so we can react to pickups/perfects/collisions.
    // NOTE: _prev* values are the values from the *previous* tick.
    if (sid === "move") this._stepMove(dt);
    else if (sid === "orbs") this._stepOrbs(dt);
    else if (sid === "perfect") this._stepPerfect(dt);
    else if (sid === "skill_phase") this._stepSkillPhase(dt);
    else if (sid === "skill_dash") this._stepSkillDash(dt);
    else if (sid === "skill_teleport") this._stepSkillTeleport(dt);
    else if (sid === "skill_slow") this._stepSkillSlow(dt);
    else if (sid === "practice") {
      // sandbox: nothing special
    }

    // Update previous tick values for the NEXT tick.
    this._prevPerfectT = this.game.perfectT;
    this._prevCombo = this.game.combo;
  }

  // ----- rendering overlay (draw AFTER game.render) -----
  renderOverlay(ctx) {
    if (!this.active) return;

    // Info panel
    const pad = 14;
    const w = Math.min(720, this.game.W - pad * 2);
    const x = (this.game.W - w) * 0.5;

    // Leave extra headroom: some HUD text lives at the very top on certain layouts,
    // and mobile safe areas can clip the first line if we hug y=0.
    const y = Math.max(pad, Math.min(72, Math.round(this.game.H * 0.075)));
    const h = 156;

    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "rgba(10,14,20,.78)";
    ctx.strokeStyle = "rgba(255,255,255,.14)";
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, x, y, w, h, 14);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const { title, body, objective } = this._uiCopy();
    const stepNum = this._stepIndex + 1;
    const stepTot = this._steps().length;

    ctx.save();
    ctx.font = "900 16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`Tutorial • Step ${stepNum}/${stepTot}`, x + 16, y + 14);

    ctx.font = "950 22px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.96)";
    ctx.fillText(title, x + 16, y + 36);

    ctx.font = "800 14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.78)";
const lines = wrapLines(ctx, body, w - 32);

const bodyTop = y + 66;
const objectiveTop = y + h - 34;
const lineH = 18;

// How many lines can fit without touching the objective strip?
const maxLines = Math.max(
  1,
  Math.floor((objectiveTop - bodyTop - 4) / lineH)
);

let ty = bodyTop;
for (const ln of lines.slice(0, maxLines)) {
  ctx.fillText(ln, x + 16, ty);
  ty += lineH;
}


    // Objective strip
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = "rgba(255,255,255,.06)";
    roundRectPath(ctx, x + 16, y + h - 34, w - 32, 22, 999);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.font = "900 13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.fillText(`Objective: ${objective}`, x + 26, y + h - 31);

    ctx.restore();

    // Guidance markers / per-step helpers
    this._renderGuides(ctx, { panel: { x, y, w, h } });

    // Skill icon intro animation (on top)
    this._renderIconIntro(ctx);

    // Flash message (on failure / feedback)
    if (this._msgFlashT > 0 && this._msgFlash) {
      const a = clamp(this._msgFlashT / 1.1, 0, 1);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = "950 18px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,.55)";
      ctx.shadowBlur = 14;
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.fillText(this._msgFlash, this.game.W * 0.5, y + h + 22);
      ctx.restore();
    }
  }

  // =====================================================
  // Step definitions
  // =====================================================
  _steps() {
    return [
      { id: "move" },
      { id: "orbs" },
      { id: "perfect" },
      { id: "skill_phase" },
      { id: "skill_dash" },
      { id: "skill_teleport" },
      { id: "skill_slow" },
      { id: "practice" },
    ];
  }

  _stepId() {
    const s = this._steps()[this._stepIndex];
    return s?.id || "practice";
  }

  _enterStep(i) {
    this._stepIndex = clamp(i | 0, 0, this._steps().length - 1);
    this._stepT = 0;
    this._iconIntro = null;

    // Reset step-specific state
    this._allowed.clear();

    this._moveWall = null;
    this._moveTarget = null;

    this._gate = null;

    this._phaseWall = null;
    this._phaseUsed = false;
    this._phasePassed = false;
    this._phaseCelebrateT = 0;

    this._dashUsed = false;
    this._dashTarget = null;
    this._dashCountdownT = 0;
    this._dashNeedReenter = false;
    this._dashReenterArmed = false;
    this._dashWasInZone = false;
    this._dashSuccessDelay = 0;
    this._dashWallsSpawned = 0;

    this._teleTarget = null;
    this._teleUsed = false;

    this._slowUsed = false;
    this._slowBurstSpawned = false;
    this._surviveT = 0;

    // Fresh run per scenario keeps it clean and beginner-friendly.
    this.game.startRun();

    const sid = this._stepId();
    if (sid !== "practice") this._freezeAutoSpawns();
    this._hardClearWorld();

    this._prevCombo = this.game.combo;
    this._prevPerfectT = this.game.perfectT;

    // Default: tutorial doesn’t teach "pipe dodge score"; focus on orbs/perfect.
    this.game.score = 0;
    this.game.combo = 0;

    if (sid === "move") {
      this._setPerfectEnabled(false);
      this._allowed = new Set();
      this._spawnMovementScenario();
    }

    if (sid === "orbs") {
      this._setPerfectEnabled(false);
      this._allowed = new Set();
      this._spawnOrbForCombo(1);

      // Exactly four walls over the course of the step.
      this._orbWallAcc = 0;
      this._orbWallsSent = 0;
      this._orbWallNextT = 0.95;
    }

    if (sid === "perfect") {
      this._setPerfectEnabled(true);
      this._spawnPerfectWall();
      this._perfectAwarded = false;
      this._perfectRespawnT = 0;
      this._delayToNext = 0;
    }

    if (sid === "skill_phase") {
      this._setPerfectEnabled(false);
      this._allowed = new Set(["phase"]);
      this._beginSkillIntro("phase");
    }

    if (sid === "skill_dash") {
      this._setPerfectEnabled(false);
      this._allowed = new Set(["dash"]);
      this._beginSkillIntro("dash");
    }

    if (sid === "skill_teleport") {
      this._setPerfectEnabled(false);
      this._allowed = new Set(["teleport"]);
      this._beginSkillIntro("teleport");
    }

    if (sid === "skill_slow") {
      this._setPerfectEnabled(false);
      this._allowed = new Set(["slowField"]);
      this._beginSkillIntro("slowField");
    }

    if (sid === "practice") {
      // Practice mode: everything unlocked, no cooldown, normal spawning.
      this._setPerfectEnabled(true);
      this._allowed = new Set(["phase", "dash", "teleport", "slowField"]);
      this._enablePracticeSandbox();
      this.pauseSim = false;
    }
  }

  _restartStep() {
    this._enterStep(this._stepIndex);
  }

  _nextStep() {
    this._enterStep(this._stepIndex + 1);
  }

// =====================================================
// Steps: movement
// =====================================================
_spawnMovementScenario() {
  // Match sketch:
  // - Player starts on the right.
  // - A tall, narrow wall sits between player and the left-side target.
  // - Wall moves to the right.
  // - Player must go around the wall (top/bottom) to reach the target zone.

  const W = this.game.W, H = this.game.H;
  const p = this.game.player;

  // Player on the right side.
  p.x = clamp(W * 0.84, p.r + 28, W - p.r - 28);
  p.y = clamp(H * 0.52, p.r + 28, H - p.r - 28);

  const th = this.game._thickness
    ? this.game._thickness()
    : Math.max(44, Math.min(W, H) * 0.075);

  const base = (this.game._pipeSpeed ? this.game._pipeSpeed() : 260);
  const spd = Math.max(170, base * 0.75); // moving right, noticeable but fair

const minLane = Math.max(90, p.r * 4 + 40); // wider lanes
const wallH = clamp(H * 0.34, H * 0.38, H * 0.44); // ~half previous height
const wallW = th;


  // Place wall between left target and player (like the sketch).
  const wx = clamp(W * 0.30, 20, W * 0.48);
  const wy = clamp(p.y - wallH * 0.5, 10, H - wallH - 10);

  this._moveWall = makePipeRect({ x: wx, y: wy, w: wallW, h: wallH, vx: spd, vy: 0 });
  this.game.pipes.push(this._moveWall);

  // Success zone on the far left ("W" box), behind the wall.
  // Keep it roughly aligned with the player's Y so the wall blocks the straight-line path.
  const tx = clamp(W * 0.10, 54, W * 0.18);
  const ty = clamp(p.y, 70, H - 70);
  this._moveTarget = {
    x: tx,
    y: ty,
    r: clamp(Math.min(W, H) * 0.055, 40, 58)
  };
}

_stepMove() {
  if (!this._moveTarget) return;
  const p = this.game.player;

  const ok = dist2(p.x, p.y, this._moveTarget.x, this._moveTarget.y) <=
             (this._moveTarget.r * this._moveTarget.r);

  if (ok) {
    this._flash("Nice — movement mastered.");
    this._nextStep();
  }
}

  // =====================================================
// Steps: orbs + combo
// =====================================================
_spawnOrbForCombo(nth) {
  // Faster: keep orbs near the middle so the step doesn't drag.
  const W = this.game.W, H = this.game.H;
  const r = clamp(Math.min(W, H) * 0.018, 10, 18);

  const cx = W * 0.52;
  const cy = H * 0.52;

  // Deterministic ring near center (no tutorial-critical RNG).
  const ring = Math.min(W, H) * 0.14; // tighter than before
  const pts = [
    { x: cx + ring * 0.95, y: cy - ring * 0.10 },
    { x: cx - ring * 0.85, y: cy + ring * 0.20 },
    { x: cx + ring * 0.50, y: cy + ring * 0.85 },
    { x: cx - ring * 0.40, y: cy - ring * 0.90 },
    { x: cx,              y: cy },
    { x: cx + ring * 0.15, y: cy - ring * 0.55 },
    { x: cx - ring * 0.15, y: cy + ring * 0.55 },
  ];

  const pt = pts[(Math.max(1, nth) - 1) % pts.length];
  const x = clamp(pt.x, r + 14, W - r - 14);
  const y = clamp(pt.y, r + 14, H - r - 14);

  // Shorter life to keep urgency, but not punishing.
  const life = 6.2;
  const o = makeOrb({ x, y, r, life, vx: 0, vy: 0 });
  this.game.orbs.push(o);
  this._lastSpawnedOrb = o;
}

_spawnOrbChallengeWall(idx) {
  // Segment hazards like slowField tutorial burst: small walls from edges.
  const W = this.game.W, H = this.game.H;
  const th = this.game._thickness ? this.game._thickness() : Math.max(46, Math.min(W, H) * 0.08);
  const base = Math.max(1, (this.game._pipeSpeed ? this.game._pipeSpeed() : 280));
  const spd = Math.max(185, base * 0.95);

  const p = this.game.player;

  // Segment sizing similar to slow burst.
  const segW = th;
  const segH = th * 3.0;

  // Deterministic pattern (no RNG): alternate sides, small offsets.
  const patterns = [
    { side: 0, dy: -120 }, // from left
    { side: 1, dy:  120 }, // from right
    { side: 2, dx: -140 }, // from top
    { side: 3, dx:  140 }, // from bottom
  ];
  const pat = patterns[idx % patterns.length];

  let x = 0, y = 0, vx = 0, vy = 0, w = segW, h = segH;

  if (pat.side === 0) {
    // Left -> right
    x = -w - 18;
    y = clamp(p.y + (pat.dy || 0), 20, H - h - 20);
    vx = spd; vy = 0;
  } else if (pat.side === 1) {
    // Right -> left
    x = W + 18;
    y = clamp(p.y + (pat.dy || 0), 20, H - h - 20);
    vx = -spd; vy = 0;
  } else if (pat.side === 2) {
    // Top -> down (rotate segment)
    w = segH; h = segW;
    x = clamp(p.x + (pat.dx || 0), 20, W - w - 20);
    y = -h - 18;
    vx = 0; vy = spd;
  } else {
    // Bottom -> up (rotate segment)
    w = segH; h = segW;
    x = clamp(p.x + (pat.dx || 0), 20, W - w - 20);
    y = H + 18;
    vx = 0; vy = -spd;
  }

  this.game.pipes.push(makePipeRect({ x, y, w, h, vx, vy }));
}

_stepOrbs(dt) {
  // Send exactly four segment hazards while the player collects orbs.
  this._orbWallAcc = (this._orbWallAcc || 0) + dt;

  // Slightly faster cadence than before.
  if (this._orbWallsSent < 4 && this._orbWallAcc >= (this._orbWallNextT || 0)) {
    // Don't stack too many segment hazards.
    if (this.game.pipes.length < 6) {
      this._spawnOrbChallengeWall(this._orbWallsSent);
      this._orbWallsSent++;
      this._orbWallNextT = (this._orbWallNextT || 0) + 1.15;
    }
  }

  const need = 5;
  if (this.game.combo >= need) {
    this._flash("Perfect. Combo understood.");
    this._nextStep();
    return;
  }

  // If the orb is gone, either it was collected or expired.
  if (this._lastSpawnedOrb && !this.game.orbs.includes(this._lastSpawnedOrb)) {
    const expired = this._lastSpawnedOrb.life <= 0;
    if (expired) {
      this._flash("Orb disappeared — combo resets to 0.");
      this._spawnOrbForCombo(this.game.combo + 1);
    } else {
      // Collected: spawn next orb.
      this._spawnOrbForCombo(this.game.combo + 1);
    }
  }
}

  // =====================================================
  // Steps: perfect gap
  // =====================================================
  _spawnPerfectWall() {
    const W = this.game.W, H = this.game.H;
    const th = this.game._thickness ? this.game._thickness() : Math.max(48, Math.min(W, H) * 0.08);
    const spd = Math.max(155, (this.game._pipeSpeed ? this.game._pipeSpeed() : 260) * 0.70);

    // Smaller, more realistic gap; randomized center so movement is required.
    const gap = clamp(H * 0.15, 86, 160);
    const minC = gap * 0.5 + 48;
    const maxC = H - gap * 0.5 - 48;
    const gapCenter = (maxC <= minC) ? (H * 0.5) : (minC + Math.random() * (maxC - minC));

    const x0 = -th - 16;
    const vx = spd;

    const top = gapCenter - gap * 0.5;
    const bot = gapCenter + gap * 0.5;

    if (top > 2) this.game.pipes.push(makePipeRect({ x: x0, y: 0, w: th, h: top, vx, vy: 0 }));
    if (H - bot > 2) this.game.pipes.push(makePipeRect({ x: x0, y: bot, w: th, h: H - bot, vx, vy: 0 }));

    this._gate = makeGate("x", x0 + th * 0.5, vx, gapCenter, gap * 0.5, th);
    this.game.gates.push(this._gate);
  }

  _stepPerfect(dt) {
    // Keep _gate.cleared reliable even if the main game doesn't mark it for tutorial gates.
    if (this._gate && !this._gate.cleared && this._gate.crossed(this.game.player.x)) {
      this._gate.cleared = true;
    }

    // Game sets perfectT when a perfect occurs.
    if (!this._perfectAwarded && this.game.perfectT > 0 && this._prevPerfectT <= 0) {
      this._perfectAwarded = true;
      this._flash("PERFECT! +10 points.");
      // Give the player a moment to enjoy the feedback.
      this._delayToNext = 0.85;
    }

    if (this._perfectAwarded) {
      this._delayToNext -= dt;
      if (this._delayToNext <= 0) this._nextStep();
      return;
    }

    // If they passed through the wall but didn't hit perfect, quickly try again.
    if (this._gate && this._gate.cleared && this._perfectRespawnT <= 0) {
      this._flash("Close — aim for the dashed line (exact center). Try again.");
      this._perfectRespawnT = 0.75;
    }

    if (this._perfectRespawnT > 0) {
      this._perfectRespawnT = Math.max(0, this._perfectRespawnT - dt);
      if (this._perfectRespawnT <= 0) {
        // Clear leftover wall pieces so the screen stays readable.
        this._hardClearWorld();
        this._spawnPerfectWall();
      }
    }
  }

  // =====================================================
  // Steps: skill intro animation
  // =====================================================
  _beginSkillIntro(skillId) {
    this._iconIntro = { skill: skillId, t: 0, dur: 0.95, done: false };
  }

  _skillSlotFor(skillId) {
    const ui = this.game._skillUI ? this.game._skillUI() : null;
    if (!ui) return null;

    const idx = ACTIONS.findIndex(a => a.id === skillId);
    const i = (idx >= 0) ? idx : 0;
    const x = ui.x0 + i * (ui.size + ui.gap);
    const y = ui.y0;
    return {
      x, y,
      cx: x + ui.size * 0.55,
      cy: y + ui.size * 0.60,
      r: ui.size * 0.22
    };
  }

  _renderIconIntro(ctx) {
    if (!this._iconIntro) return;

    const { skill, t, dur, done } = this._iconIntro;
    const k = easeInOutCubic(dur > 1e-6 ? (t / dur) : 1);
    const slot = this._skillSlotFor(skill);
    if (!slot) return;

    const sx = this.game.W * 0.5;
    const sy = this.game.H * 0.5;
    const sr = Math.max(70, Math.min(this.game.W, this.game.H) * 0.12);

    const x = lerp(sx, slot.cx, k);
    const y = lerp(sy, slot.cy, k);
    const r = lerp(sr, slot.r, k);

    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = lerp(0.95, 0.85, k);
    ctx.lineWidth = Math.max(2.2, r * 0.10);
    ctx.strokeStyle = "rgba(255,255,255,.90)";
    ctx.fillStyle = "rgba(255,255,255,.14)";

    // Halo
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.shadowColor = "rgba(120,210,255,.55)";
    ctx.shadowBlur = 40;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.65, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Draw the same icon style used by the HUD.
    if (typeof this.game._drawSkillIcon === "function") {
      this.game._drawSkillIcon(skill, r);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    if (done) {
      // Start the scenario right after the intro completes.
      this._iconIntro = null;
      this._pendingActions.length = 0;
      this.pauseSim = false;
      const sid = this._stepId();
      if (sid === "skill_phase") this._spawnPhaseScenario();
      if (sid === "skill_dash") this._spawnDashScenario();
      if (sid === "skill_teleport") this._spawnTeleportScenario();
      if (sid === "skill_slow") this._spawnSlowScenario();
    }
  }

  // =====================================================
  // Skill: PHASE (invulnerability)
  // =====================================================
  _spawnPhaseScenario() {
    const W = this.game.W, H = this.game.H;
    const th = this.game._thickness ? this.game._thickness() : Math.max(48, Math.min(W, H) * 0.08);
    const spd = Math.max(200, (this.game._pipeSpeed ? this.game._pipeSpeed() : 280) * 0.9);

    // Full-height wall from the left: cannot be dodged.
    const x0 = -th - 18;
    const y0 = -2;
    this._phaseWall = makePipeRect({ x: x0, y: y0, w: th, h: H + 4, vx: spd, vy: 0 });
    this.game.pipes.push(this._phaseWall);
  }

  _stepSkillPhase(dt) {
    if (!this._phaseWall) return;

    // Detect use.
    if (!this._phaseUsed && this.game.player.invT > 0) this._phaseUsed = true;

    const p = this.game.player;

    // Completed when the wall is fully past the player (with a short celebration buffer).
    if (this._phaseUsed && !this._phasePassed && this._phaseWall.x > (p.x + p.r + 6)) {
      this._phasePassed = true;
      this._phaseCelebrateT = 0.9;
      this._flash("Great — Phase lets you ignore collisions briefly.");
    }

    if (this._phasePassed) {
      this._phaseCelebrateT = Math.max(0, this._phaseCelebrateT - dt);
      if (this._phaseCelebrateT <= 0) this._nextStep();
    }
  }

  // =====================================================
  // Skill: DASH
  // =====================================================
  _spawnDashScenario() {
    const W = this.game.W, H = this.game.H;
    const p = this.game.player;

    // Spawn player bottom-left.
    p.x = clamp(W * 0.16, p.r + 28, W - p.r - 28);
    p.y = clamp(H * 0.84, p.r + 28, H - p.r - 28);

    // Success zone top-right.
    const tx = clamp(W * 0.86, 70, W - 70);
    const ty = clamp(H * 0.18, 70, H - 70);
    this._dashTarget = { x: tx, y: ty, r: clamp(Math.min(W, H) * 0.060, 44, 62) };

    // Five seconds to make it.
    this._dashCountdownT = 5.0;
    this._dashNeedReenter = false;
    this._dashReenterArmed = false;
    this._dashWasInZone = false;
    this._dashSuccessDelay = 0;
    this._dashWallsSpawned = 0;

    // Send one or two small walls moving left across the map.
    this._spawnDashWalls();
  }

  _spawnDashWalls() {
    const W = this.game.W, H = this.game.H;
    const th = this.game._thickness ? this.game._thickness() : Math.max(46, Math.min(W, H) * 0.08);
    const base = (this.game._pipeSpeed ? this.game._pipeSpeed() : 260);
    const spd = Math.max(175, base * 0.75);

    const mk = (x, y, w, h, vx, vy) => this.game.pipes.push(makePipeRect({ x, y, w, h, vx, vy }));

    const blockW = th;
    const blockH = th * 2.6;

    // Block 1 (mid-lane)
    mk(W + 18, clamp(H * 0.58, 20, H - blockH - 20), blockW, blockH, -spd, 0);

    // Block 2 (upper-mid) on larger screens
    if (Math.min(W, H) >= 520) {
      mk(W + 18 + th * 2.0, clamp(H * 0.32, 20, H - blockH - 20), blockW, blockH, -spd, 0);
    }
  }

  _stepSkillDash(dt) {
    if (!this._dashTarget) return;

    // Detect dash usage.
    if (!this._dashUsed && this.game.player.dashT > 0) this._dashUsed = true;

    // Countdown.
    this._dashCountdownT = Math.max(0, (this._dashCountdownT || 0) - dt);

    const p = this.game.player;
    const ok = dist2(p.x, p.y, this._dashTarget.x, this._dashTarget.y) <= (this._dashTarget.r * this._dashTarget.r);

    // Zone entry logic to enforce "must dash to proceed".
    if (ok && !this._dashWasInZone) {
      if (this._dashUsed) {
        this._flash("Dash = a burst of speed in your movement direction.");
        this._dashSuccessDelay = 0.85;
      } else {
        this._flash("Good — now use DASH and touch the zone again.");
        this._dashNeedReenter = true;
      }
    }

    // If they reached the zone without dashing, require exit + re-entry after a dash.
    if (!ok && this._dashNeedReenter && this._dashWasInZone) {
      this._dashReenterArmed = true;
    }
    if (ok && this._dashNeedReenter && this._dashUsed && this._dashReenterArmed && !this._dashWasInZone) {
      this._flash("Nice dash.");
      this._dashSuccessDelay = 0.85;
    }

    this._dashWasInZone = ok;

    // Success delay (lets the player understand what happened).
    if (this._dashSuccessDelay > 0) {
      this._dashSuccessDelay = Math.max(0, this._dashSuccessDelay - dt);
      if (this._dashSuccessDelay <= 0) this._nextStep();
      return;
    }

    // Fail on timeout.
    if (this._dashCountdownT <= 0) {
      if (!this._dashUsed) this._flash("Too slow — you must DASH to make it in time.");
      else this._flash("Time’s up — try again and take a cleaner line.");
      this._restartStep();
    }
  }

  // =====================================================
  // Skill: TELEPORT
  // =====================================================
  _spawnTeleportScenario() {
    const W = this.game.W, H = this.game.H;
    const th = this.game._thickness ? this.game._thickness() : Math.max(48, Math.min(W, H) * 0.08);
    const p = this.game.player;

    // Static cage around player (vx=vy=0)
    const pad = Math.max(86, p.r * 4.2);
    const left = clamp(p.x - pad, 24, W - 24);
    const right = clamp(p.x + pad, 24, W - 24);
    const top = clamp(p.y - pad, 24, H - 24);
    const bot = clamp(p.y + pad, 24, H - 24);

    // Build a closed box: left/right walls + top/bottom walls
    this.game.pipes.push(makePipeRect({ x: left - th, y: top - th, w: th, h: (bot - top) + th * 2, vx: 0, vy: 0 }));
    this.game.pipes.push(makePipeRect({ x: right, y: top - th, w: th, h: (bot - top) + th * 2, vx: 0, vy: 0 }));
    this.game.pipes.push(makePipeRect({ x: left, y: top - th, w: (right - left), h: th, vx: 0, vy: 0 }));
    this.game.pipes.push(makePipeRect({ x: left, y: bot, w: (right - left), h: th, vx: 0, vy: 0 }));

    // Target zone outside the cage
    const tx = clamp(W * 0.80, 70, W - 70);
    const ty = clamp(H * 0.78, 70, H - 70);
    this._teleTarget = { x: tx, y: ty, r: 44 };
  }

  _stepSkillTeleport() {
    if (!this._teleTarget) return;

    const p = this.game.player;
    const ok = dist2(p.x, p.y, this._teleTarget.x, this._teleTarget.y) <= (this._teleTarget.r * this._teleTarget.r);
    if (ok && this._teleUsed) {
      this._flash("Teleport is instant — aim with your cursor.");
      this._nextStep();
    }
  }

  // =====================================================
  // Skill: SLOW FIELD
  // =====================================================
  _spawnSlowScenario() {
    // Wait for cast, then spawn a short, intense burst.
    this._slowBurstSpawned = false;
    this._surviveT = 0;
  }

  _spawnSlowBurst() {
    const W = this.game.W, H = this.game.H;
    const th = this.game._thickness ? this.game._thickness() : Math.max(48, Math.min(W, H) * 0.08);
    const base = Math.max(1, (this.game._pipeSpeed ? this.game._pipeSpeed() : 280));
    const spd = base * 1.55;

    const p = this.game.player;
    const mk = (side, dx, dy) => {
      // Side: 0 L,1 R,2 T,3 B
      let x = 0, y = 0, vx = 0, vy = 0, w = 0, h = 0;
      if (side === 0) { w = th; h = th * 4.2; x = -w - 18; y = clamp(p.y + dy, 20, H - h - 20); vx = spd; vy = 0; }
      if (side === 1) { w = th; h = th * 4.2; x = W + 18; y = clamp(p.y + dy, 20, H - h - 20); vx = -spd; vy = 0; }
      if (side === 2) { w = th * 4.2; h = th; x = clamp(p.x + dx, 20, W - w - 20); y = -h - 18; vx = 0; vy = spd; }
      if (side === 3) { w = th * 4.2; h = th; x = clamp(p.x + dx, 20, W - w - 20); y = H + 18; vx = 0; vy = -spd; }
      this.game.pipes.push(makePipeRect({ x, y, w, h, vx, vy }));
    };

    // A few aimed-ish pipes (but still very dodgeable once slowed).
    mk(0, 0, -110);
    mk(0, 0, 110);
    mk(1, 0, -80);
    mk(1, 0, 80);
    mk(2, -120, 0);
    mk(2, 120, 0);
    mk(3, -90, 0);
    mk(3, 90, 0);
  }

  _stepSkillSlow(dt) {
    if (!this._slowUsed && this.game.slowField) {
      this._slowUsed = true;
      this._flash("Nice — walls slow down inside the circle.");
    }

    if (this._slowUsed && !this._slowBurstSpawned) {
      this._slowBurstSpawned = true;
      this._spawnSlowBurst();
      this._surviveT = 2.6;
    }

    if (this._slowBurstSpawned) {
      this._surviveT = Math.max(0, this._surviveT - dt);
      if (this._surviveT <= 0) {
        this._flash("Tutorial complete — practice with everything unlocked.");
        this._nextStep();
      }
    }
  }

  // =====================================================
  // UI copy + guides
  // =====================================================
  _uiCopy() {
    const binds = this.getBinds();
    const key = (id) => humanizeBind(binds?.[id]);
    const sid = this._stepId();

    if (sid === "move") {
      return {
        title: "Movement (WASD)",
        body:
          "Use W/A/S/D to move.\n\n" +
          "A pipe is blocking the straight path to the left. Move around it and enter the highlighted zone.\n\n" +
          "Skills are disabled for now so you can focus on movement.",
        objective: "Move into the highlighted zone on the left. (Auto-retries on failure.)"
      };
    }

    if (sid === "orbs") {
      return {
        title: "Orbs + Combo Points",
        body:
          "Pick up orbs to score points.\n" +
          "First orb = 5 points, then 6, then 7… (the combo bar shows your streak).\n" +
          "Walls will also start coming — dodge them while you collect orbs.",
        objective: `Collect 5 orbs in a row. (Current combo: ${this.game.combo}/5)`
      };
    }

    if (sid === "perfect") {
      return {
        title: "Perfect Thread (+10)",
        body:
          "When a wall crosses you, try to be exactly in the center of the opening.\n" +
          "The dashed line shows the exact center of the current gap.\n" +
          "Hit the center to earn a PERFECT banner (+10).",
        objective: "Get 1 PERFECT by staying centered in the gap."
      };
    }

    if (sid === "skill_phase") {
      return {
        title: "Skill: Phase (Invulnerability)",
        body:
          `Press ${key("phase")} to become invulnerable briefly.\n` +
          "A solid wall is coming — you cannot dodge it. Use Phase right before it hits you.",
        objective: `Use Phase (${key("phase")}) to pass through the full wall.`
      };
    }

    if (sid === "skill_dash") {
      const t = Math.ceil(Math.max(0, this._dashCountdownT || 0));
      return {
        title: "Skill: Dash",
        body:
          `Dash is a burst of speed in your movement direction.\n` +
          `Hold a direction (W/A/S/D) and press ${key("dash")}.\n` +
          "Reach the highlighted zone in the top-right before the countdown ends.\n" +
          "You must use Dash at least once to advance.",
        objective: `Reach the highlighted zone in ${t}s using Dash (${key("dash")}).`
      };
    }

    if (sid === "skill_teleport") {
      return {
        title: "Skill: Teleport",
        body:
          `Teleport jumps you instantly to your cursor.\n` +
          `Move your mouse to aim, then press ${key("teleport")}.\n` +
          "Teleport to the highlighted zone to escape the cage.",
        objective: `Teleport (${key("teleport")}) into the highlighted circle.`
      };
    }

    if (sid === "skill_slow") {
      return {
        title: "Skill: Slow Field",
        body:
          `Slow Field creates a circle that slows walls inside it.\n` +
          `Press ${key("slowField")} to place it on yourself.\n` +
          "After you cast it, a burst of walls will come — dodge them while they’re slowed.",
        objective: `Cast Slow Field (${key("slowField")}) and survive the burst.`
      };
    }

    // practice
    return {
      title: "Practice Mode",
      body:
        "Tutorial complete.\n\n" +
        "All abilities are unlocked with NO cooldown:\n" +
        "• Phase • Dash • Teleport • Slow Field\n\n" +
        "Practice as long as you want, then press Enter (or Esc) to exit.",
      objective: "Use any skill freely. Press Enter (or Esc) to exit."
    };
  }

  _renderGuides(ctx, meta = null) {
    const sid = this._stepId();

    // Movement: highlight goal zone (left side).
    if (sid === "move" && this._moveTarget) {
      ctx.save();
      ctx.globalAlpha = 0.62;
      ctx.strokeStyle = "rgba(255,255,255,.90)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(this._moveTarget.x, this._moveTarget.y, this._moveTarget.r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = 0.20;
      ctx.fillStyle = "rgba(120,210,255,.85)";
      ctx.beginPath();
      ctx.arc(this._moveTarget.x, this._moveTarget.y, this._moveTarget.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Perfect: draw a center line at the gapCenter.
    if (sid === "perfect" && this._gate) {
      const y = this._gate.gapCenter;
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = "rgba(255,255,255,.80)";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      ctx.beginPath();
      ctx.moveTo(12, y);
      ctx.lineTo(this.game.W - 12, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = 0.65;
      ctx.fillStyle = "rgba(120,210,255,.95)";
      ctx.beginPath();
      ctx.arc(this.game.W * 0.5, y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Dash: highlight target area + countdown.
    if (sid === "skill_dash" && this._dashTarget) {
      ctx.save();
      ctx.globalAlpha = 0.60;
      ctx.strokeStyle = "rgba(255,255,255,.90)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(this._dashTarget.x, this._dashTarget.y, this._dashTarget.r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = 0.20;
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.beginPath();
      ctx.arc(this._dashTarget.x, this._dashTarget.y, this._dashTarget.r, 0, Math.PI * 2);
      ctx.fill();

      // Big countdown below the tutorial panel.
      const t = Math.ceil(Math.max(0, this._dashCountdownT || 0));
      const panel = meta?.panel;
      const cx = this.game.W * 0.5;
      const cy = panel ? (panel.y + panel.h + 58) : (this.game.H * 0.22);

      ctx.globalAlpha = 0.92;
      ctx.font = "950 54px system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,.55)";
      ctx.shadowBlur = 18;
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.fillText(String(t), cx, cy);

      ctx.restore();
    }

    // Teleport: highlight target zone.
    if (sid === "skill_teleport" && this._teleTarget) {
      ctx.save();
      ctx.globalAlpha = 0.60;
      ctx.strokeStyle = "rgba(255,255,255,.90)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(this._teleTarget.x, this._teleTarget.y, this._teleTarget.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "rgba(210,170,255,.75)";
      ctx.beginPath();
      ctx.arc(this._teleTarget.x, this._teleTarget.y, this._teleTarget.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // =====================================================
  // Config overrides + world controls
  // =====================================================
  _backupAndOverrideConfig() {
    const cfg = this.game.cfg;
    // Only backup the fields we touch.
    this._cfgBackup = {
      pipeDodge: cfg?.scoring?.pipeDodge,
      orbBase: cfg?.scoring?.orbBase,
      orbComboBonus: cfg?.scoring?.orbComboBonus,
      orbComboMax: cfg?.scoring?.orbComboMax,
      perfectEnabled: cfg?.scoring?.perfect?.enabled,
      perfectBonus: cfg?.scoring?.perfect?.bonus,
      perfectWindowScale: cfg?.scoring?.perfect?.windowScale,
      perfectFlashDuration: cfg?.scoring?.perfect?.flashDuration,
      catalystsOrbsEnabled: cfg?.catalysts?.orbs?.enabled,
      // Skill tuning (gentle tutorial-friendly values)
      dashCooldown: cfg?.skills?.dash?.cooldown,
      phaseCooldown: cfg?.skills?.phase?.cooldown,
      teleportCooldown: cfg?.skills?.teleport?.cooldown,
      slowCooldown: cfg?.skills?.slowField?.cooldown,
      phaseDuration: cfg?.skills?.phase?.duration,
      slowDuration: cfg?.skills?.slowField?.duration,
      slowRadius: cfg?.skills?.slowField?.radius,
      slowFactor: cfg?.skills?.slowField?.slowFactor,
    };

    // Tutorial clarity: do NOT award points for pipes leaving the screen.
    if (cfg?.scoring) cfg.scoring.pipeDodge = 0;

    // Enforce the tutorial’s stated orb scoring: 5,6,7…
    if (cfg?.scoring) {
      cfg.scoring.orbBase = 5;
      cfg.scoring.orbComboBonus = 1;
      cfg.scoring.orbComboMax = Math.max(10, Number(cfg.scoring.orbComboMax) || 10);
    }

    // Keep the tutorial deterministic and uncluttered: manual orb spawns.
    if (cfg?.catalysts?.orbs) cfg.catalysts.orbs.enabled = false;

    // Make skills forgiving during tutorial.
    if (cfg?.skills?.dash) cfg.skills.dash.cooldown = 0;
    if (cfg?.skills?.phase) {
      cfg.skills.phase.cooldown = 0;
      cfg.skills.phase.duration = Math.max(1.4, Number(cfg.skills.phase.duration) || 1.4);
    }
    if (cfg?.skills?.teleport) cfg.skills.teleport.cooldown = 0;
    if (cfg?.skills?.slowField) {
      cfg.skills.slowField.cooldown = 0;
      cfg.skills.slowField.duration = Math.max(4.5, Number(cfg.skills.slowField.duration) || 4.5);
      cfg.skills.slowField.radius = Math.max(220, Number(cfg.skills.slowField.radius) || 220);
      cfg.skills.slowField.slowFactor = clamp(Number(cfg.skills.slowField.slowFactor) || 0.35, 0.18, 0.55);
    }
  }

  _enablePracticeSandbox() {
    // Re-enable normal spawns (pipes/orbs/specials) while keeping skills at 0 cooldown.
    const cfg = this.game.cfg;
    const b = this._cfgBackup;

    if (cfg?.catalysts?.orbs && b) cfg.catalysts.orbs.enabled = !!b.catalystsOrbsEnabled;

    // Restore the game's normal scoring rules for practice, if available.
    if (cfg?.scoring && b) {
      if (typeof b.pipeDodge !== "undefined") cfg.scoring.pipeDodge = b.pipeDodge;
      if (typeof b.orbBase !== "undefined") cfg.scoring.orbBase = b.orbBase;
      if (typeof b.orbComboBonus !== "undefined") cfg.scoring.orbComboBonus = b.orbComboBonus;
      if (typeof b.orbComboMax !== "undefined") cfg.scoring.orbComboMax = b.orbComboMax;
      if (cfg.scoring.perfect && typeof b.perfectBonus !== "undefined") cfg.scoring.perfect.bonus = b.perfectBonus;
      if (cfg.scoring.perfect && typeof b.perfectWindowScale !== "undefined") cfg.scoring.perfect.windowScale = b.perfectWindowScale;
      if (cfg.scoring.perfect && typeof b.perfectFlashDuration !== "undefined") cfg.scoring.perfect.flashDuration = b.perfectFlashDuration;
      if (cfg.scoring.perfect) cfg.scoring.perfect.enabled = true;
    }

    // Ensure a quick start to the sandbox.
    this.game.pipeT = Math.min(this.game.pipeT || 0.7, 0.7);
    this.game.specialT = Math.min(this.game.specialT || 4.5, 4.5);
    this.game.orbT = Math.min(this.game.orbT || 1.6, 1.6);

    // Keep skill cooldowns at zero for practice (config + live cds).
    if (cfg?.skills?.dash) cfg.skills.dash.cooldown = 0;
    if (cfg?.skills?.phase) cfg.skills.phase.cooldown = 0;
    if (cfg?.skills?.teleport) cfg.skills.teleport.cooldown = 0;
    if (cfg?.skills?.slowField) cfg.skills.slowField.cooldown = 0;

    this.game.cds.dash = 0;
    this.game.cds.phase = 0;
    this.game.cds.teleport = 0;
    this.game.cds.slowField = 0;
  }

  _restoreConfig() {
    const cfg = this.game.cfg;
    const b = this._cfgBackup;
    if (!cfg || !b) return;

    if (cfg?.scoring) {
      cfg.scoring.pipeDodge = b.pipeDodge;
      cfg.scoring.orbBase = b.orbBase;
      cfg.scoring.orbComboBonus = b.orbComboBonus;
      cfg.scoring.orbComboMax = b.orbComboMax;
      if (cfg.scoring.perfect) {
        cfg.scoring.perfect.enabled = b.perfectEnabled;
        cfg.scoring.perfect.bonus = b.perfectBonus;
        cfg.scoring.perfect.windowScale = b.perfectWindowScale;
        cfg.scoring.perfect.flashDuration = b.perfectFlashDuration;
      }
    }
    if (cfg?.catalysts?.orbs) cfg.catalysts.orbs.enabled = b.catalystsOrbsEnabled;

    if (cfg?.skills?.dash) cfg.skills.dash.cooldown = b.dashCooldown;
    if (cfg?.skills?.phase) {
      cfg.skills.phase.cooldown = b.phaseCooldown;
      cfg.skills.phase.duration = b.phaseDuration;
    }
    if (cfg?.skills?.teleport) cfg.skills.teleport.cooldown = b.teleportCooldown;
    if (cfg?.skills?.slowField) {
      cfg.skills.slowField.cooldown = b.slowCooldown;
      cfg.skills.slowField.duration = b.slowDuration;
      cfg.skills.slowField.radius = b.slowRadius;
      cfg.skills.slowField.slowFactor = b.slowFactor;
    }
  }

  _setPerfectEnabled(on) {
    const cfg = this.game.cfg;
    if (!cfg?.scoring?.perfect) return;
    cfg.scoring.perfect.enabled = !!on;
    if (on) {
      cfg.scoring.perfect.bonus = 10;
      // Slightly more forgiving for tutorial, while still teaching “center”.
      cfg.scoring.perfect.windowScale = 0.26;
      cfg.scoring.perfect.flashDuration = 0.7;
    }
  }

  _freezeAutoSpawns() {
    // Prevent the normal game loop from generating random hazards/orbs.
    // (We orchestrate everything deterministically.)
    this.game.pipeT = 1e9;
    this.game.specialT = 1e9;
    this.game.orbT = 1e9;
  }

  _hardClearWorld() {
    // Keep the visuals, clear the gameplay entities.
    this.game.pipes.length = 0;
    this.game.gates.length = 0;
    this.game.orbs.length = 0;
    this.game.parts.length = 0;
    this.game.floats.length = 0;
    this.game.slowField = null;
    this.game.cds.dash = 0;
    this.game.cds.phase = 0;
    this.game.cds.teleport = 0;
    this.game.cds.slowField = 0;
    this.game.player.invT = 0;
    this.game.player.dashT = 0;
  }

  _flash(msg) {
    this._msgFlash = String(msg || "");
    this._msgFlashT = 1.1;
  }
}
