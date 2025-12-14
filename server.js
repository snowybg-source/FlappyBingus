// =====================
// FILE: server.js
// Node 24+ (no external deps)
// =====================
"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const crypto = require("node:crypto");

// --------- Config (env overrides) ----------
const PORT = Number(process.env.PORT || 3000);

// Recommended project layout:
//   /server.js
//   /public/flappybingus.html
//   /public/file.png
//   /public/config.json (optional)
//   /data/db.json (auto-created)
//
// You can override public dir/data dir via env:
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.join(process.cwd(), "public");

const DATA_DIR = process.env.BINGUS_DATA_DIR
  ? path.resolve(process.env.BINGUS_DATA_DIR)
  : path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), "data");

const DB_PATH = path.join(DATA_DIR, "db.json");

// Cookie that holds username (per requirements)
const USER_COOKIE = "sugar";

// Cosmetic trail unlocks (progression based on BEST score)
const TRAILS = Object.freeze([
  { id: "classic", name: "Classic", minScore: 0 },
  { id: "rainbow", name: "Rainbow", minScore: 100 },
  { id: "gothic", name: "Gothic", minScore: 150 }
]);

// --------- Simple JSON "DB" ----------
/**
 * db shape:
 * {
 *   users: {
 *     [keyLower]: {
 *       username: "Alice",
 *       key: "alice",
 *       bestScore: 0,
 *       selectedTrail: "classic",
 *       runs: 0,
 *       totalScore: 0,
 *       createdAt: 1690000000000,
 *       updatedAt: 1690000000000
 *     }
 *   }
 * }
 */
let db = { users: {} };
let saveChain = Promise.resolve();

function nowMs() { return Date.now(); }

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function loadDb() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.users && typeof parsed.users === "object") {
      db = parsed;
      return;
    }
  } catch (_) {
    // first run or invalid JSON -> recreate
  }
  db = { users: {} };
  await saveDb();
}

async function writeFileAtomic(filePath, text) {
  const tmp = filePath + ".tmp." + crypto.randomBytes(6).toString("hex");
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, filePath);
}

function saveDb() {
  // serialize saves to avoid interleaving writes
  saveChain = saveChain.then(async () => {
    await ensureDir(DATA_DIR);
    const text = JSON.stringify(db, null, 2);
    await writeFileAtomic(DB_PATH, text);
  }).catch(() => {});
  return saveChain;
}

// --------- Helpers ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function send(res, status, headers, body) {
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, obj, extraHeaders = {}) {
  send(res, status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  }, JSON.stringify(obj));
}

function sendHtml(res, status, html, extraHeaders = {}) {
  send(res, status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  }, html);
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: "not_found" });
}

function badRequest(res, msg = "bad_request") {
  sendJson(res, 400, { ok: false, error: msg });
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, error: "unauthorized" });
}

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  const parts = header.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    // cookie values are percent-encoded by us
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const maxAge = Number.isFinite(opts.maxAge) ? opts.maxAge : 60 * 60 * 24 * 365; // 1y
  const parts = [
    `${name}=${encodeURIComponent(String(value))}`,
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    "Path=/",
    "SameSite=Lax"
  ];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Max-Age=0; Path=/; SameSite=Lax`);
}

// Username: no password, but keep it reasonable + safe.
function normalizeUsername(input) {
  const u = String(input ?? "").trim();
  if (u.length < 3 || u.length > 18) return null;
  // allow letters, numbers, spaces, underscore, hyphen
  if (!/^[A-Za-z0-9 _-]+$/.test(u)) return null;
  return u;
}

function keyForUsername(username) {
  return String(username).trim().toLowerCase();
}

function unlockedTrails(bestScore) {
  const s = Number(bestScore) || 0;
  return TRAILS.filter(t => s >= t.minScore).map(t => t.id);
}

function publicUser(u) {
  if (!u) return null;
  return {
    username: u.username,
    bestScore: u.bestScore | 0,
    selectedTrail: u.selectedTrail || "classic",
    runs: u.runs | 0,
    totalScore: u.totalScore | 0,
    unlockedTrails: unlockedTrails(u.bestScore | 0)
  };
}

function getUserFromReq(req) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[USER_COOKIE];
  if (!raw) return null;
  const key = keyForUsername(raw);
  const u = db.users[key];
  if (!u) return null;
  return u;
}

function getOrCreateUser(username) {
  const norm = normalizeUsername(username);
  if (!norm) return null;
  const key = keyForUsername(norm);
  let u = db.users[key];
  if (!u) {
    const t = nowMs();
    u = {
      username: norm,
      key,
      bestScore: 0,
      selectedTrail: "classic",
      runs: 0,
      totalScore: 0,
      createdAt: t,
      updatedAt: t
    };
    db.users[key] = u;
  }
  return u;
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function topHighscores(limit = 25) {
  const list = Object.values(db.users)
    .map(u => ({ username: u.username, bestScore: u.bestScore | 0, updatedAt: u.updatedAt | 0 }))
    .sort((a, b) => (b.bestScore - a.bestScore) || (b.updatedAt - a.updatedAt) || a.username.localeCompare(b.username));
  return list.slice(0, Math.max(1, Math.min(200, limit | 0)));
}

// --------- Static serving ----------
async function serveStatic(reqPath, res) {
  // Map root to flappybingus.html
  if (reqPath === "/") reqPath = "/flappybingus.html";

  // Prevent path traversal
  const decoded = safeDecodePath(reqPath);
  if (decoded == null) return notFound(res);

  const joined = path.join(PUBLIC_DIR, decoded);
  const resolved = path.resolve(joined);
  const root = path.resolve(PUBLIC_DIR);

  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return notFound(res);
  }

  let st;
  try {
    st = await fs.stat(resolved);
  } catch (_) {
    return notFound(res);
  }

  if (st.isDirectory()) {
    // allow / -> flappybingus.html only; otherwise no directory listing
    return notFound(res);
  }

  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";

  // Basic caching: cache images/static for a bit; keep HTML no-store.
  const isHtml = ext === ".html";
  const cache = isHtml ? "no-store" : "public, max-age=3600";

  try {
    const data = await fs.readFile(resolved);
    send(res, 200, { "Content-Type": type, "Cache-Control": cache }, data);
  } catch (_) {
    sendJson(res, 500, { ok: false, error: "read_failed" });
  }
}

function safeDecodePath(p) {
  // remove query already handled outside; ensure leading /
  if (!p.startsWith("/")) return null;
  let decoded;
  try { decoded = decodeURIComponent(p); } catch { return null; }
  // Normalize and ensure we don't escape root
  decoded = decoded.replaceAll("\\", "/");
  const norm = path.posix.normalize(decoded);
  if (norm.includes("..")) return null;
  // remove leading slash for path.join
  return norm.replace(/^\/+/, "");
}

// --------- API routes ----------
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // CORS not needed (same-origin), but handle OPTIONS politely
  if (req.method === "OPTIONS") {
    send(res, 204, {
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Origin": req.headers.origin || "*",
      "Access-Control-Max-Age": "86400"
    }, "");
    return;
  }

  // API: who am I?
  if (pathname === "/api/me" && req.method === "GET") {
    const u = getUserFromReq(req);
    sendJson(res, 200, { ok: true, user: publicUser(u), trails: TRAILS });
    return;
  }

  // API: register/login by username (sets cookie)
  if (pathname === "/api/register" && req.method === "POST") {
    let body;
    try { body = await readJsonBody(req); } catch { return badRequest(res, "invalid_json"); }
    const username = normalizeUsername(body.username);
    if (!username) return badRequest(res, "invalid_username");

    const u = getOrCreateUser(username);
    u.updatedAt = nowMs();
    await saveDb();

    // Store username in cookie "sugar"
    // HttpOnly: server doesn't need client JS to read it; client calls /api/me.
    setCookie(res, USER_COOKIE, u.username, { httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
    sendJson(res, 200, { ok: true, user: publicUser(u), trails: TRAILS });
    return;
  }

  // API: submit score (updates best score + progression)
  if (pathname === "/api/score" && req.method === "POST") {
    const u = getUserFromReq(req);
    if (!u) return unauthorized(res);

    let body;
    try { body = await readJsonBody(req); } catch { return badRequest(res, "invalid_json"); }
    const s = Number(body.score);
    if (!Number.isFinite(s)) return badRequest(res, "invalid_score");

    const score = Math.max(0, Math.min(1_000_000_000, Math.floor(s)));

    u.runs = (u.runs | 0) + 1;
    u.totalScore = (u.totalScore | 0) + score;
    if (score > (u.bestScore | 0)) u.bestScore = score;
    u.updatedAt = nowMs();

    // Ensure selectedTrail is not illegal (must be unlocked)
    const unlocked = unlockedTrails(u.bestScore | 0);
    if (!unlocked.includes(u.selectedTrail)) {
      u.selectedTrail = "classic";
    }

    await saveDb();

    sendJson(res, 200, {
      ok: true,
      user: publicUser(u),
      trails: TRAILS,
      highscores: topHighscores(20)
    });
    return;
  }

  // API: set selected trail cosmetic
  if (pathname === "/api/cosmetics/trail" && req.method === "POST") {
    const u = getUserFromReq(req);
    if (!u) return unauthorized(res);

    let body;
    try { body = await readJsonBody(req); } catch { return badRequest(res, "invalid_json"); }
    const trailId = String(body.trailId || "").trim();
    const exists = TRAILS.some(t => t.id === trailId);
    if (!exists) return badRequest(res, "invalid_trail");

    const unlocked = unlockedTrails(u.bestScore | 0);
    if (!unlocked.includes(trailId)) return badRequest(res, "trail_locked");

    u.selectedTrail = trailId;
    u.updatedAt = nowMs();
    await saveDb();

    sendJson(res, 200, { ok: true, user: publicUser(u), trails: TRAILS });
    return;
  }

  // API: highscores
  if (pathname === "/api/highscores" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") || 20);
    sendJson(res, 200, { ok: true, highscores: topHighscores(limit) });
    return;
  }

  // (Optional) simple HTML highscores page
  if (pathname === "/highscores" && req.method === "GET") {
    const list = topHighscores(50);
    const rows = list.map((e, i) =>
      `<tr><td class="mono">${i + 1}</td><td>${escapeHtml(e.username)}</td><td class="mono">${e.bestScore}</td></tr>`
    ).join("");
    sendHtml(res, 200, `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Flappy Bingus – High Scores</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#0b1220;color:#e5e7eb}
  header{padding:18px 16px;border-bottom:1px solid rgba(255,255,255,.10);background:#0b1020}
  .wrap{max-width:820px;margin:0 auto;padding:18px 16px}
  table{width:100%;border-collapse:collapse;background:#0f172a;border:1px solid rgba(255,255,255,.10);border-radius:12px;overflow:hidden}
  th,td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left}
  th{background:rgba(255,255,255,.04)}
  .mono{font-family:ui-monospace,Menlo,Monaco,Consolas,monospace}
  a{color:#7dd3fc;text-decoration:none}
</style>
</head>
<body>
<header><div class="wrap"><b>High Scores</b> • <a href="/">Back to game</a></div></header>
<div class="wrap">
  <table>
    <thead><tr><th>#</th><th>User</th><th>Best</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="3">No scores yet.</td></tr>`}</tbody>
  </table>
</div>
</body></html>`);
    return;
  }

  // Static files (including / -> flappybingus.html)
  return serveStatic(pathname, res);
}

// --------- Server start ----------
(async () => {
  // ensure public dir exists (optional)
  if (!fssync.existsSync(PUBLIC_DIR)) {
    console.warn(`[bingus] PUBLIC_DIR missing: ${PUBLIC_DIR}`);
  }
  await ensureDir(DATA_DIR);
  await loadDb();

  const server = http.createServer((req, res) => {
    // lightweight error boundary
    route(req, res).catch((err) => {
      console.error("[bingus] handler error:", err);
      sendJson(res, 500, { ok: false, error: "internal_error" });
    });
  });

  server.listen(PORT, () => {
    console.log(`[bingus] listening on :${PORT}`);
    console.log(`[bingus] serving public from ${PUBLIC_DIR}`);
    console.log(`[bingus] db at ${DB_PATH}`);
  });
})();
