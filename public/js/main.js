// =====================
// FILE: public/js/main.js
// =====================
import { loadConfig } from "./config.js";
import {
  apiGetMe,
  apiRegister,
  apiGetHighscores,
  apiSetTrail,
  apiSubmitScore,
  apiSetKeybinds
} from "./api.js";

import { escapeHtml, clamp, getCookie, setCookie, setRandSource, createSeededRand, createTapeRandRecorder, createTapeRandPlayer } from "./util.js";

import { Game } from "./game.js";

import {
  ACTIONS,
  DEFAULT_KEYBINDS,
  loadGuestBinds,
  saveGuestBinds,
  mergeBinds,
  humanizeBind,
  applyRebindWithSwap,
  keyEventToBind,
  pointerEventToBind
} from "./keybinds.js";

import { Input } from "./input.js";

// ---- DOM ----
const canvas = document.getElementById("c");

const menu = document.getElementById("menu");
const over = document.getElementById("over");

const startBtn = document.getElementById("start");
const restartBtn = document.getElementById("restart");
const toMenuBtn = document.getElementById("toMenu");

const bootPill = document.getElementById("bootPill");
const bootText = document.getElementById("bootText");

const usernameInput = document.getElementById("usernameInput");
const saveUserBtn = document.getElementById("saveUserBtn");
const userHint = document.getElementById("userHint");

const trailSelect = document.getElementById("trailSelect");
const trailHint = document.getElementById("trailHint");

const bindWrap = document.getElementById("bindWrap");
const bindHint = document.getElementById("bindHint");

const hsWrap = document.getElementById("hsWrap");

const pbText = document.getElementById("pbText");
const trailText = document.getElementById("trailText");

const finalEl = document.getElementById("final");
const overPB = document.getElementById("overPB");

const seedInput = document.getElementById("seedInput");
const seedRandomBtn = document.getElementById("seedRandomBtn");
const seedHint = document.getElementById("seedHint");

const watchReplayBtn = document.getElementById("watchReplay");
const exportGifBtn = document.getElementById("exportGif");
const exportMp4Btn = document.getElementById("exportMp4");
const replayStatus = document.getElementById("replayStatus");

// ---- Local best fallback cookie (legacy support) ----
const LOCAL_BEST_COOKIE = "chocolate_chip";
function readLocalBest() {
  const raw = getCookie(LOCAL_BEST_COOKIE);
  const n = Number.parseInt(raw, 10);
  return (Number.isFinite(n) && n >= 0) ? Math.min(n, 1e9) : 0;
}
function writeLocalBest(v) {
  setCookie(LOCAL_BEST_COOKIE, String(Math.max(0, Math.min(1e9, v | 0))), 3650);
}

// ---- Seed cookie ----
const SEED_COOKIE = "sesame_seed";
function readSeed() {
  const raw = getCookie(SEED_COOKIE);
  try { return raw ? decodeURIComponent(raw) : ""; } catch { return raw || ""; }
}
function writeSeed(s) {
  setCookie(SEED_COOKIE, String(s ?? ""), 3650);
}
function genRandomSeed() {
  const u = new Uint32Array(2);
  crypto.getRandomValues(u);
  return `${u[0].toString(16)}-${u[1].toString(16)}`;
}

// ---- Boot + runtime state ----
const boot = { imgReady: false, imgOk: false, cfgReady: false, cfgOk: false, cfgSrc: "defaults" };

const net = {
  online: true,
  user: null,
  trails: [
    { id: "classic", name: "Classic", minScore: 0 },
    { id: "rainbow", name: "Rainbow", minScore: 100 },
    { id: "gothic", name: "Gothic", minScore: 150 }
  ],
  highscores: []
};

// keybinds: start from guest cookie; override from server user when available
let binds = loadGuestBinds();

// config + assets
let CFG = null;

// assets
const playerImg = new Image();
playerImg.src = "file.png";
playerImg.onload = () => { boot.imgReady = true; boot.imgOk = true; refreshBootUI(); };
playerImg.onerror = () => { boot.imgReady = true; boot.imgOk = false; refreshBootUI(); };

// ---- Input + Game ----
const ctx = canvas.getContext("2d", { alpha: false });

// Deterministic sim clock
const SIM_DT = 1 / 120;
const MAX_FRAME = 1 / 20;
let acc = 0;
let lastTs = 0;

// Replay / run capture
// activeRun = { seed, ticks: [ { move, cursor, actions[] } ], pendingActions:[], ended:boolean }
let activeRun = null;

// When true: main RAF loop does NOT advance the sim (replay drives it)
let replayDriving = false;

// IMPORTANT: actions are NOT applied immediately.
// They are enqueued and applied at the next simulation tick boundary.
// This makes live run and replay have identical action timing.
const input = new Input(canvas, () => binds, (actionId) => {
  if (activeRun && game.state === 1 /* PLAY */) {
    activeRun.pendingActions.push({
      id: actionId,
      cursor: { x: input.cursor.x, y: input.cursor.y, has: input.cursor.has }
    });
  }
  // DO NOT call game.handleAction(actionId) here.
});
input.install();

const game = new Game({
  canvas,
  ctx,
  config: null,
  playerImg,
  input,
  getTrailId: () => {
    if (net.user?.selectedTrail) return net.user.selectedTrail;
    return trailSelect.value || "classic";
  },
  getBinds: () => binds,
  onGameOver: (score) => onGameOver(score)
});

window.addEventListener("resize", () => game.resizeToWindow());

// ---- Boot UI ----
function refreshBootUI() {
  startBtn.disabled = !(boot.imgReady && boot.cfgReady);

  bootPill.classList.remove("ok", "bad", "neutral");
  const ready = boot.imgReady && boot.cfgReady;
  if (!ready) {
    bootPill.classList.add("neutral");
    bootText.textContent = "Loading…";
    return;
  }
  bootPill.classList.add("ok");
  const a = boot.imgOk ? "player ok" : "player fallback";
  const b = boot.cfgOk ? boot.cfgSrc : "defaults";
  const c = net.online ? (net.user ? `user: ${net.user.username}` : "guest") : "offline";
  bootText.textContent = `${a} • ${b} • ${c}`;
}

// ---- Menu rendering (highscores, cosmetics, binds) ----
function setUserHint() {
  if (!net.online) {
    userHint.className = "hint bad";
    userHint.textContent = "Server unreachable. Guest mode enabled (no global highscores).";
    return;
  }
  if (!net.user) {
    userHint.className = "hint";
    userHint.textContent = "Enter a username to save progression and appear on the leaderboard.";
    return;
  }
  userHint.className = "hint good";
  userHint.textContent = `Signed in as ${net.user.username}. Runs: ${net.user.runs} • Total: ${net.user.totalScore}`;
}

function getUnlockedTrails(bestScore) {
  const s = bestScore | 0;
  return net.trails.filter(t => s >= t.minScore).map(t => t.id);
}

function fillTrailSelect() {
  const best = (net.user ? (net.user.bestScore | 0) : readLocalBest());
  const unlocked = new Set(getUnlockedTrails(best));
  const selected = net.user?.selectedTrail || trailSelect.value || "classic";

  trailSelect.innerHTML = "";
  for (const t of net.trails) {
    const opt = document.createElement("option");
    opt.value = t.id;
    const locked = !unlocked.has(t.id);
    opt.textContent = locked ? `${t.name} (locked: ${t.minScore})` : t.name;
    opt.disabled = locked;
    trailSelect.appendChild(opt);
  }

  const safeSel = unlocked.has(selected) ? selected : "classic";
  trailSelect.value = safeSel;

  trailText.textContent = safeSel;
  pbText.textContent = String(best);

  if (!net.user) {
    trailHint.className = "hint warn";
    trailHint.textContent = "Guest mode: unlocks are based on your local best cookie. Register to save progression globally.";
  } else {
    trailHint.className = "hint";
    trailHint.textContent = `Unlock: Rainbow @ 100 • Gothic @ 150. Your best: ${best}`;
  }
}

function renderHighscores() {
  if (!net.online) {
    hsWrap.className = "hint bad";
    hsWrap.textContent = "Leaderboard unavailable (offline).";
    return;
  }
  const hs = net.highscores || [];
  if (!hs.length) {
    hsWrap.className = "hint";
    hsWrap.textContent = "No scores yet. Be the first.";
    return;
  }

  hsWrap.className = "";
  const table = document.createElement("table");
  table.className = "hsTable";

  const thead = document.createElement("thead");
  thead.innerHTML = `<tr><th>#</th><th>User</th><th class="mono">Best</th></tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  hs.slice(0, 10).forEach((e, i) => {
    const tr = document.createElement("tr");
    const isMe = net.user && e.username === net.user.username;
    tr.innerHTML =
      `<td class="mono">${i + 1}</td>` +
      `<td>${escapeHtml(e.username)}${isMe ? " (you)" : ""}</td>` +
      `<td class="mono">${e.bestScore | 0}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  hsWrap.innerHTML = "";
  hsWrap.appendChild(table);
}

function renderBindUI(listeningActionId = null) {
  bindWrap.innerHTML = "";
  for (const a of ACTIONS) {
    const row = document.createElement("div");
    row.className = "bindRow" + (listeningActionId === a.id ? " listen" : "");
    row.dataset.action = a.id;

    const name = document.createElement("div");
    name.className = "bindName";
    name.textContent = a.label;

    const key = document.createElement("div");
    key.className = "bindKey kbd";
    key.textContent = humanizeBind(binds[a.id]);

    const btn = document.createElement("button");
    btn.className = "bindBtn";
    btn.textContent = (listeningActionId === a.id) ? "Listening…" : "Rebind";
    btn.disabled = (listeningActionId !== null);
    btn.dataset.action = a.id;

    row.appendChild(name);
    row.appendChild(key);
    row.appendChild(btn);
    bindWrap.appendChild(row);
  }
}

// ---- Server refresh ----
async function refreshProfileAndHighscores() {
  const me = await apiGetMe();
  if (!me) {
    net.online = false;
    net.user = null;
  } else {
    net.online = true;
    net.user = me.user || null;
    net.trails = me.trails || net.trails;
    if (net.user?.keybinds) binds = mergeBinds(DEFAULT_KEYBINDS, net.user.keybinds);
  }

  const hs = await apiGetHighscores(20);
  if (!hs) {
    net.online = false;
    net.highscores = [];
  } else {
    net.online = true;
    net.highscores = hs.highscores || [];
  }

  setUserHint();
  fillTrailSelect();
  renderHighscores();
  renderBindUI();
  refreshBootUI();
}

// ---- Registration ----
saveUserBtn.addEventListener("click", async () => {
  const username = usernameInput.value.trim();
  const res = await apiRegister(username);
  if (!res) {
    net.online = false;
    setUserHint();
    refreshBootUI();
    return;
  }
  if (res.ok) {
    net.online = true;
    net.user = res.user;
    net.trails = res.trails || net.trails;

    binds = mergeBinds(DEFAULT_KEYBINDS, net.user.keybinds);
    usernameInput.value = net.user.username;

    await apiSetKeybinds(binds);
    await refreshProfileAndHighscores();
  }
});

// ---- Replay UI ----
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

async function playReplay({ captureMode = "none" } = {}) {
  setRandSource(createTapeRandPlayer(activeRun.rngTape));
  if (!activeRun || !activeRun.ended || !activeRun.ticks || !activeRun.ticks.length) {
    if (replayStatus) {
      replayStatus.className = "hint bad";
      replayStatus.textContent = "No replay available yet (finish a run first).";
    }
    return null;
  }

  replayDriving = true;
  try {
    // Same seed => same RNG stream (gameplay only; visuals must not consume it)
    setRandSource(createSeededRand(activeRun.seed));

    // Fake input for deterministic playback
    const replayInput = {
      cursor: { x: 0, y: 0, has: false },
      _move: { dx: 0, dy: 0 },
      getMove() { return this._move; }
    };

    const realInput = game.input;
    game.input = replayInput;

    // reset accumulator and start clean run
    acc = 0;
    input.reset();
    menu.classList.add("hidden");
    over.classList.add("hidden");
    game.startRun();

    // Optional capture (WebM)
    let recorder = null;
    let recordedChunks = [];
    if (captureMode !== "none") {
      const stream = canvas.captureStream(60);
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm;codecs=vp8";
      recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
      recorder.start();
    }

    for (let i = 0; i < activeRun.ticks.length; i++) {
      const tk = activeRun.ticks[i];

      // Apply inputs for this tick
      replayInput._move = tk.move || { dx: 0, dy: 0 };
      replayInput.cursor.x = tk.cursor?.x ?? 0;
      replayInput.cursor.y = tk.cursor?.y ?? 0;
      replayInput.cursor.has = !!tk.cursor?.has;

      // Apply actions scheduled for this tick (exactly like live tick processing)
      if (Array.isArray(tk.actions)) {
        for (const a of tk.actions) {
          if (a && a.cursor) {
            replayInput.cursor.x = a.cursor.x;
            replayInput.cursor.y = a.cursor.y;
            replayInput.cursor.has = !!a.cursor.has;
          }
          game.handleAction(a.id);
        }
      }

      // Step exactly one tick
      game.update(SIM_DT);
      game.render();

      await new Promise(requestAnimationFrame);
      if (game.state === 2 /* OVER */) break;
    }

    let webmBlob = null;
    if (recorder) {
      await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
      webmBlob = new Blob(recordedChunks, { type: recorder.mimeType || "video/webm" });
    }

    // Restore real input
    game.input = realInput;

    over.classList.remove("hidden");
    return webmBlob;
  } finally {
    replayDriving = false;
  }
}

// ---- Cosmetics selection ----
trailSelect.addEventListener("change", async () => {
  const id = trailSelect.value;
  trailText.textContent = id;

  if (!net.user) return;

  const res = await apiSetTrail(id);
  if (!res) { net.online = false; setUserHint(); return; }
  if (res.ok) {
    net.online = true;
    net.user = res.user;
    net.trails = res.trails || net.trails;
    fillTrailSelect();
  }
});

// ---- Keybind rebinding flow ----
let rebindActive = null;
let rebindCleanup = null;

function beginRebind(actionId) {
  if (rebindActive) return;
  rebindActive = actionId;
  bindHint.className = "hint good";
  bindHint.textContent =
    `Rebinding ${ACTIONS.find(a => a.id === actionId)?.label || actionId}… press a key or click a mouse button (Esc cancels).`;
  renderBindUI(rebindActive);

  const finish = async (newBind, cancel = false) => {
    if (!rebindActive) return;

    if (rebindCleanup) rebindCleanup();
    rebindCleanup = null;

    const action = rebindActive;
    rebindActive = null;

    if (cancel) {
      bindHint.className = "hint";
      bindHint.textContent = "Rebind cancelled.";
      renderBindUI(null);
      return;
    }

    const before = binds;
    const { binds: updated, swappedWith } = applyRebindWithSwap(binds, action, newBind);
    binds = updated;

    if (net.user) {
      const res = await apiSetKeybinds(binds);
      if (res && res.ok) {
        net.user = res.user;
      } else {
        binds = before;
        bindHint.className = "hint bad";
        bindHint.textContent = "Server rejected keybinds (conflict/invalid). Reverted.";
      }
    } else {
      saveGuestBinds(binds);
    }

    if (swappedWith) {
      bindHint.className = "hint warn";
      bindHint.textContent =
        `That input was already in use; swapped bindings with ${ACTIONS.find(a => a.id === swappedWith)?.label || swappedWith}.`;
    } else {
      bindHint.className = "hint good";
      bindHint.textContent = "Keybind updated.";
    }

    renderBindUI(null);
  };

  const onKeyDownCapture = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "Escape") finish(null, true);
    else finish(keyEventToBind(e), false);
  };

  const onPointerDownCapture = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    finish(pointerEventToBind(e), false);
  };

  window.addEventListener("keydown", onKeyDownCapture, { capture: true });
  window.addEventListener("pointerdown", onPointerDownCapture, { capture: true });

  rebindCleanup = () => {
    window.removeEventListener("keydown", onKeyDownCapture, { capture: true });
    window.removeEventListener("pointerdown", onPointerDownCapture, { capture: true });
  };
}

bindWrap.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const actionId = btn.dataset.action;
  if (!actionId) return;
  beginRebind(actionId);
});

// ---- Menu/game over buttons ----
startBtn.addEventListener("click", () => startGame());
restartBtn.addEventListener("click", () => startGame());
toMenuBtn.addEventListener("click", () => toMenu());

window.addEventListener("keydown", (e) => {
  if (e.code === "Enter" && !startBtn.disabled && !menu.classList.contains("hidden")) {
    e.preventDefault();
    startGame();
  }
  if (e.code === "Escape") {
    if (!menu.classList.contains("hidden")) return;
    e.preventDefault();
    toMenu();
  }
  if (e.code === "KeyR" && !over.classList.contains("hidden")) {
    e.preventDefault();
    startGame();
  }
}, { passive: false });

// ---- State transitions ----
function toMenu() {
  if (rebindCleanup) rebindCleanup();
  rebindCleanup = null;
  rebindActive = null;

  over.classList.add("hidden");
  menu.classList.remove("hidden");

  game.setStateMenu();
  refreshProfileAndHighscores();
}

function startGame() {
  if (rebindCleanup) rebindCleanup();
  rebindCleanup = null;
  rebindActive = null;

  input.reset();

  // seed selection
  let seed = (seedInput ? seedInput.value.trim() : "").trim();
  if (!seed) {
    seed = genRandomSeed();
    if (seedInput) seedInput.value = seed;
  }
  writeSeed(seed);



// reset replay recording (tick-based) + RNG tape
  activeRun = { seed, ticks: [], pendingActions: [], ended: false, rngTape: [] };

// IMPORTANT: record the exact RNG stream used during gameplay
  setRandSource(createTapeRandRecorder(seed, activeRun.rngTape));

  if (replayStatus) {
    replayStatus.className = "hint";
    replayStatus.textContent = `Recording replay… Seed: ${seed}`;
  }
  if (exportGifBtn) exportGifBtn.disabled = true;
  if (exportMp4Btn) exportMp4Btn.disabled = true;

  menu.classList.add("hidden");
  over.classList.add("hidden");

  acc = 0;
  game.startRun();
  window.focus();
}

async function onGameOver(finalScore) {
  finalEl.textContent = String(finalScore | 0);

  const localBest = readLocalBest();
  if ((finalScore | 0) > (localBest | 0)) writeLocalBest(finalScore | 0);

  const pb = net.user ? (net.user.bestScore | 0) : readLocalBest();
  overPB.textContent = String(pb);

  over.classList.remove("hidden");

  if (net.user) {
    const res = await apiSubmitScore(finalScore | 0);
    if (res && res.ok) {
      net.user = res.user;
      net.trails = res.trails || net.trails;
      net.highscores = res.highscores || net.highscores;

      fillTrailSelect();
      renderHighscores();

      overPB.textContent = String(net.user.bestScore | 0);
    }
  }

  if (activeRun) {
    activeRun.ended = true;
    if (replayStatus) {
      replayStatus.className = "hint good";
      replayStatus.textContent = `Replay ready. Seed: ${activeRun.seed} • Ticks: ${activeRun.ticks.length}`;
    }
    if (exportGifBtn) exportGifBtn.disabled = false;
    if (exportMp4Btn) exportMp4Btn.disabled = false;
  }
}
let _ffmpegSingleton = null;

async function loadFFmpeg() {
  if (_ffmpegSingleton) return _ffmpegSingleton;

  // Import from your own origin
  const ffmpegMod = await import("/vendor/ffmpeg/ffmpeg/index.js");
  const utilMod = await import("/vendor/ffmpeg/util/index.js");

  const fetchFile = utilMod.fetchFile || ffmpegMod.fetchFile;
  if (!fetchFile) throw new Error("fetchFile not found. Ensure /vendor/ffmpeg/util/ is present.");

  // Create instance using whatever API your module provides
  let ffmpeg = null;

  if (typeof ffmpegMod.FFmpeg === "function") {
    // Newer API: class
    ffmpeg = new ffmpegMod.FFmpeg();
  } else if (typeof ffmpegMod.createFFmpeg === "function") {
    // Older API: factory
    ffmpeg = ffmpegMod.createFFmpeg({ log: false });
  } else {
    // Print exports to console so you can see what you actually imported
    console.log("ffmpeg module exports:", Object.keys(ffmpegMod));
    throw new Error("No FFmpeg constructor or createFFmpeg() found in /vendor/ffmpeg/ffmpeg/index.js");
  }

  // Load core/worker from SAME ORIGIN
  // Newer class API: ffmpeg.load({ coreURL, wasmURL, workerURL })
  // Older createFFmpeg API: ffmpeg.load() with corePath-style options (varies)
  if (typeof ffmpeg.load === "function") {
    // Try modern signature first
    try {
      await ffmpeg.load({
        coreURL: "/vendor/ffmpeg/core/ffmpeg-core.js",
        wasmURL: "/vendor/ffmpeg/core/ffmpeg-core.wasm",
        workerURL: "/vendor/ffmpeg/worker/worker.js",
      });
    } catch (e) {
      // Fallback: some builds expect corePath only
      // This fallback is harmless if unsupported; it will throw and we rethrow with detail.
      console.warn("Modern ffmpeg.load() signature failed; trying corePath fallback.", e);
      if (ffmpeg.setLogger) ffmpeg.setLogger(() => {});
      await ffmpeg.load(); // if your build embeds paths or uses defaults from same-origin
    }
  } else {
    throw new Error("ffmpeg instance has no load() method. Wrong build copied.");
  }

  _ffmpegSingleton = { ffmpeg, fetchFile };
  return _ffmpegSingleton;
}

async function transcodeWithFFmpeg({ webmBlob, outExt }) {
  const { ffmpeg, fetchFile } = await loadFFmpeg();

  await ffmpeg.writeFile("in.webm", await fetchFile(webmBlob));

  if (outExt === "mp4") {
    // MP4 (H.264)
    await ffmpeg.exec([
      "-i", "in.webm",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "out.mp4"
    ]);
    const data = await ffmpeg.readFile("out.mp4");
    return new Blob([data.buffer], { type: "video/mp4" });
  } else {
    // GIF with palette for quality
    await ffmpeg.exec(["-i", "in.webm", "-vf", "fps=30,scale=640:-1:flags=lanczos,palettegen", "pal.png"]);
    await ffmpeg.exec(["-i", "in.webm", "-i", "pal.png", "-lavfi", "fps=30,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse", "out.gif"]);
    const data = await ffmpeg.readFile("out.gif");
    return new Blob([data.buffer], { type: "image/gif" });
  }
}
// ---- Main loop (fixed timestep + tick capture) ----
function frame(ts) {
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  dt = clamp(dt, 0, MAX_FRAME);

  if (!replayDriving) {
    acc += dt;

    while (acc >= SIM_DT) {
      // Capture input snapshot for THIS tick
      const snap = input.snapshot();

      // Drain actions enqueued since last tick and apply them now (live run)
      // This matches exactly what replay will do.
      let actions = [];
      if (activeRun && game.state === 1 /* PLAY */) {
        actions = activeRun.pendingActions.splice(0);
      }

      // Record tick data
      if (activeRun && game.state === 1 /* PLAY */) {
        activeRun.ticks.push({
          move: snap.move,
          cursor: snap.cursor,
          actions
        });
      }

      // Apply actions for this tick to the live game
      if (game.state === 1 /* PLAY */ && actions.length) {
        for (const a of actions) {
          // For teleport: ensure the input cursor reflects the recorded cursor for that action
          if (a && a.cursor) {
            input.cursor.x = a.cursor.x;
            input.cursor.y = a.cursor.y;
            input.cursor.has = !!a.cursor.has;
          }
          game.handleAction(a.id);
        }
      }

      // Step simulation
      game.update(SIM_DT);
      acc -= SIM_DT;

      if (game.state === 2 /* OVER */) {
        if (activeRun) activeRun.pendingActions.length = 0;
        break;
      }
    }

    game.render();
  }

  requestAnimationFrame(frame);
}

// ---- Boot init ----
(async function init() {
  // Seed UI init (ONLY ONCE)
  if (seedInput) seedInput.value = readSeed() || "";

  if (seedRandomBtn) {
    seedRandomBtn.addEventListener("click", () => {
      const s = genRandomSeed();
      if (seedInput) seedInput.value = s;
      writeSeed(s);
      if (seedHint) {
        seedHint.className = "hint good";
        seedHint.textContent = `Generated seed: ${s}`;
      }
    });
  }
  if (seedInput) {
    seedInput.addEventListener("change", () => {
      writeSeed(seedInput.value.trim());
      if (seedHint) {
        seedHint.className = "hint";
        seedHint.textContent = "If two players use the same seed, pipe/orb spawns will match.";
      }
    });
  }


exportMp4Btn?.addEventListener("click", async () => {
  try {
    replayStatus.textContent = "Exporting MP4… (replaying + encoding)";
    const webm = await playReplay({ captureMode: "webm" });
    if (!webm) throw new Error("No WebM captured from replay.");

    const mp4 = await transcodeWithFFmpeg({ webmBlob: webm, outExt: "mp4" });
    downloadBlob(mp4, `flappy-bingus-${activeRun.seed}.mp4`);
    replayStatus.textContent = "MP4 exported.";
  } catch (e) {
    console.error(e);
    replayStatus.textContent = "MP4 export failed (see console).";
  }
});

exportGifBtn?.addEventListener("click", async () => {
  try {
    replayStatus.textContent = "Exporting GIF… (replaying + encoding)";
    const webm = await playReplay({ captureMode: "webm" });
    if (!webm) throw new Error("No WebM captured from replay.");

    const gif = await transcodeWithFFmpeg({ webmBlob: webm, outExt: "gif" });
    downloadBlob(gif, `flappy-bingus-${activeRun.seed}.gif`);
    replayStatus.textContent = "GIF exported.";
  } catch (e) {
    console.error(e);
    replayStatus.textContent = "GIF export failed (see console).";
  }
});



  if (watchReplayBtn) {
    watchReplayBtn.addEventListener("click", async () => {
      if (replayStatus) {
        replayStatus.className = "hint";
        replayStatus.textContent = "Playing replay…";
      }
      await playReplay({ captureMode: "none" });
      if (replayStatus) {
        replayStatus.className = "hint good";
        replayStatus.textContent = "Replay finished.";
      }
    });
  }

  // Export buttons remain wired, but you still need the corrected FFmpeg loader.
  // Keep them disabled if you haven't fixed FFmpeg yet.
  if (exportGifBtn) exportGifBtn.disabled = true;
  if (exportMp4Btn) exportMp4Btn.disabled = true;

  // config
  const cfgRes = await loadConfig();
  CFG = cfgRes.config;
  boot.cfgReady = true;
  boot.cfgOk = cfgRes.ok;
  boot.cfgSrc = cfgRes.source;

  game.cfg = CFG;

  game.resizeToWindow();
  game.setStateMenu();
  renderBindUI();

  await refreshProfileAndHighscores();
  refreshBootUI();

  requestAnimationFrame((t) => {
    lastTs = t;
    requestAnimationFrame(frame);
  });
})();
