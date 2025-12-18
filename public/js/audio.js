// =====================
// FILE: public/js/audio.js
// =====================
let ctx = null;

let musicBuffer = null;
let boopBuffer = null;
let niceBuffer = null;

let musicGain = null;
let sfxGain = null;

let musicSource = null;
let musicPlaying = false;

async function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    musicGain = ctx.createGain();
    sfxGain = ctx.createGain();

    // Sensible defaults; tweak to taste
    musicGain.gain.value = 0.35;
    sfxGain.gain.value = 0.65;

    musicGain.connect(ctx.destination);
    sfxGain.connect(ctx.destination);
  }
  // Ensure resumed after user gesture
  if (ctx.state === "suspended") await ctx.resume();
  return ctx;
}

async function loadBuffer(url) {
  const c = await getCtx();
  const res = await fetch(url, { cache: "force-cache" });
  const arr = await res.arrayBuffer();
  return await c.decodeAudioData(arr);
}

export async function audioInit({ musicUrl, boopUrl, niceUrl } = {}) {
  // Must be called from a user gesture (Start / Restart click)
  await getCtx();

  // Load lazily once
  if (musicUrl && !musicBuffer) musicBuffer = await loadBuffer(musicUrl);
  if (boopUrl && !boopBuffer) boopBuffer = await loadBuffer(boopUrl);
    if (niceUrl && !niceBuffer) niceBuffer = await loadBuffer(niceUrl); // NEW
}

export function setMusicVolume(v01) {
  if (musicGain) musicGain.gain.value = Math.max(0, Math.min(1, v01));
}
export function setSfxVolume(v01) {
  if (sfxGain) sfxGain.gain.value = Math.max(0, Math.min(1, v01));
}

export function musicStartLoop() {
  if (!ctx || !musicBuffer || musicPlaying) return;

  // Stop any previous source defensively
  try { musicSource?.stop(); } catch {}

  const src = ctx.createBufferSource();
  src.buffer = musicBuffer;
  src.loop = true;

  src.connect(musicGain);
  src.start(0);

  musicSource = src;
  musicPlaying = true;

  src.onended = () => {
    // onended can fire if stopped; keep state coherent
    if (musicSource === src) {
      musicSource = null;
      musicPlaying = false;
    }
  };
}

export function musicStop() {
  if (!musicSource) return;
  try { musicSource.stop(0); } catch {}
  musicSource = null;
  musicPlaying = false;
}

export function sfxOrbBoop(combo = 0) {
  if (!ctx || !boopBuffer || !sfxGain) return;

  const src = ctx.createBufferSource();
  src.buffer = boopBuffer;

  const c = Math.max(0, combo | 0);
  src.playbackRate.value = Math.min(2.0, 1.0 + c * 0.04);

  const g = ctx.createGain();
  g.gain.value = 1.0;

  src.connect(g);
  g.connect(sfxGain);

  src.start(0);
}

export function sfxPerfectNice() {
  if (!ctx || !niceBuffer || !sfxGain) return;

  const src = ctx.createBufferSource();
  src.buffer = niceBuffer;

  const g = ctx.createGain();
  g.gain.value = 1.0;

  src.connect(g);
  g.connect(sfxGain);

  src.start(0);
}
