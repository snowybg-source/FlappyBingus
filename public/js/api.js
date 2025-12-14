
async function requestJson(url, opts = {}) {
  try {
    const res = await fetch(url, {
      credentials: "same-origin",
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers || {})
      }
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return null;
    return data;
  } catch {
    return null;
  }
}

export async function apiGetMe() {
  return requestJson("/api/me", { method: "GET" });
}

export async function apiRegister(username) {
  return requestJson("/api/register", { method: "POST", body: JSON.stringify({ username }) });
}

export async function apiSubmitScore(score) {
  return requestJson("/api/score", { method: "POST", body: JSON.stringify({ score }) });
}

export async function apiSetTrail(trailId) {
  return requestJson("/api/cosmetics/trail", { method: "POST", body: JSON.stringify({ trailId }) });
}

export async function apiSetKeybinds(keybinds) {
  return requestJson("/api/binds", { method: "POST", body: JSON.stringify({ keybinds }) });
}

export async function apiGetHighscores(limit = 20) {
  return requestJson(`/api/highscores?limit=${encodeURIComponent(String(limit))}`, { method: "GET" });
}
