// Stockage local de la session Dougs (cookies), partagé entre login.mjs et server.mjs.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const BASE = process.env.DOUGS_BASE_URL || "https://app.dougs.fr";
export const SESSION_FILE = process.env.DOUGS_SESSION_FILE || join(homedir(), ".config", "dougs-mcp", "session.json");

export function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try { return JSON.parse(readFileSync(SESSION_FILE, "utf8")); } catch { return null; }
}

export function saveSession(session) {
  mkdirSync(dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_FILE, JSON.stringify({ ...session, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  chmodSync(SESSION_FILE, 0o600);
}

export function mergeCookies(cookieHeader, setCookies) {
  const jar = new Map((cookieHeader || "").split(";").map(c => c.trim()).filter(Boolean).map(c => {
    const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)];
  }));
  for (const sc of setCookies) {
    const pair = sc.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function headers(cookie) {
  return {
    ...(cookie ? { Cookie: cookie } : {}),
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: BASE,
    Referer: BASE + "/app/",
    "User-Agent": "Mozilla/5.0 dougs-mcp",
  };
}
