// =====================
// FILE: public/js/config.js
// =====================
import { clamp } from "./util.js";

export const DEFAULT_CONFIG = {
  player: { maxSpeed: 420, accel: 2600, friction: 16, sizeScale: 0.055, sizeMin: 28, sizeMax: 54, radiusScale: 0.38 },
  pipes: {
    difficulty: { timeToMax: 38, scoreToMax: 120, mixTime: 0.55, mixScore: 0.45 },
    spawnInterval: { start: 0.78, end: 0.23, min: 0.18, max: 0.90 },
    speed: { start: 240, end: 560 },
    thickness: { scale: 0.055, min: 28, max: 64 },
    gap: { startScale: 0.30, endScale: 0.20, min: 88, max: 190 },
    special: { startCadence: 3.8, endCadence: 2.3, jitterMin: 0.2, jitterMax: 0.7 },
    patternWeights: { wall: [0.18, 0.30], aimed: [0.26, 0.40] },
    colors: { green: "#34d399", blue: "#60a5fa", yellow: "#fbbf24", red: "#fb7185" }
  },
  skills: {
    // cooldowns live here; activation keybinds are user-configurable (menu)
    dash: { cooldown: 1.15, duration: 0.18, speed: 900 },
    phase: { cooldown: 1.75, duration: 0.40 },
    teleport: { cooldown: 2.10, range: 170, effectDuration: 0.35, burstParticles: 34 },
    slowField: { cooldown: 4.50, duration: 1.80, radius: 210, slowFactor: 0.58 }
  },
  catalysts: {
    orbs: { enabled: true, intervalMin: 0.95, intervalMax: 1.65, maxOnScreen: 6, lifetime: 10.0, radius: 12, driftSpeedMin: 10, driftSpeedMax: 45, safeDistance: 120 }
  },
  scoring: {
    pipeDodge: 1,
    orbBase: 5,
    orbComboBonus: 1,
    orbComboMax: 30,
    perfect: { enabled: true, bonus: 10, windowScale: 0.075, flashDuration: 0.55 }
  },
  ui: { comboBar: { glowAt: 8, sparkleAt: 12, sparkleRate: 28 } }
};

function isPlainObject(v) { return v && typeof v === "object" && !Array.isArray(v); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function mergeKnown(base, incoming) {
  if (Array.isArray(base)) return Array.isArray(incoming) ? incoming.slice() : base.slice();
  if (!isPlainObject(base)) {
    if (incoming === undefined) return base;
    if (typeof base === "number") { const n = Number(incoming); return Number.isFinite(n) ? n : base; }
    if (typeof base === "boolean") { return (incoming === true || incoming === false) ? incoming : base; }
    if (typeof base === "string") { return (typeof incoming === "string") ? incoming : base; }
    return base;
  }
  const out = {};
  const src = isPlainObject(incoming) ? incoming : {};
  for (const k of Object.keys(base)) out[k] = mergeKnown(base[k], src[k]);
  return out;
}

async function tryFetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return JSON.parse(await res.text());
}

export async function loadConfig() {
  const candidates = ["flappy_bingus_config.json", "config.json"];
  let cfg = clone(DEFAULT_CONFIG);
  let source = "defaults";
  let ok = false;

  for (const c of candidates) {
    try {
      const loaded = await tryFetchJson(c);
      if (loaded && isPlainObject(loaded)) {
        cfg = mergeKnown(DEFAULT_CONFIG, loaded);
        source = c;
        ok = true;
      }
      break;
    } catch (_) {}
  }

  // minor sanity clamps
  cfg.pipes.spawnInterval.start = clamp(cfg.pipes.spawnInterval.start, cfg.pipes.spawnInterval.min, cfg.pipes.spawnInterval.max);
  cfg.pipes.spawnInterval.end = clamp(cfg.pipes.spawnInterval.end, cfg.pipes.spawnInterval.min, cfg.pipes.spawnInterval.max);

  return { config: cfg, ok, source };
}
