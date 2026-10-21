#!/usr/bin/env node
// Connexion interactive à Dougs : email + mot de passe + code MFA, puis session sauvegardée
// dans ~/.config/dougs-mcp/session.json (droits 600). Le serveur MCP la lit au démarrage.
//
//   npm run login            (ou: node login.mjs)
//   DOUGS_EMAIL=... npm run login

import readline from "node:readline";
import { BASE, SESSION_FILE, saveSession, mergeCookies, headers } from "./session.mjs";

let cookie = "";

async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: headers(cookie), body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length) cookie = mergeCookies(cookie, sc);
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); else rl.output.write("*"); };
    }
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(answer.trim()); });
  });
}

const email = process.env.DOUGS_EMAIL || await ask("Email Dougs : ");
const password = await ask("Mot de passe : ", { hidden: true });

const login = await call("POST", "/auth/api/login", { email, password });
if (!login.ok) {
  console.error(`Échec du login (${login.status}) :`, login.data?.message ?? login.data);
  process.exit(1);
}

// MFA éventuelle
let me = await call("GET", "/users/me");
if (!me.ok) {
  const factors = await call("GET", "/auth/api/mfa/enabled-factors");
  const list = Array.isArray(factors.data) ? factors.data : factors.data?.factors ?? [];
  const types = list.map(f => (typeof f === "string" ? f : f.type ?? f.name)).filter(Boolean);
  let type = types.find(t => /totp|authenticator|app/i.test(t)) ?? types.find(t => /mail/i.test(t)) ?? types[0] ?? "email";
  if (types.length > 1) {
    const pick = await ask(`Facteurs MFA disponibles : ${types.join(", ")}. Lequel ? [${type}] `);
    if (pick) type = pick;
  }
  if (/mail/i.test(type)) {
    const sent = await call("POST", "/auth/api/mfa/send-email", {});
    if (!sent.ok) console.error("Envoi du mail MFA :", sent.status, sent.data?.message ?? "");
    else console.log("Code envoyé par email.");
  }
  const token = await ask("Code MFA : ");
  const verify = await call("POST", "/auth/api/mfa/verify", { token, type });
  if (!verify.ok) {
    console.error(`Code refusé (${verify.status}) :`, verify.data?.message ?? verify.data);
    process.exit(1);
  }
  me = await call("GET", "/users/me");
}

if (!me.ok) {
  console.error("Connecté mais /users/me refuse la session :", me.status, me.data?.message ?? "");
  process.exit(1);
}

// Société : env, sinon la première du compte
let companyId = process.env.DOUGS_COMPANY_ID;
if (!companyId && me.data?.id) {
  const companies = await call("GET", `/users/${me.data.id}/companies`);
  const list = Array.isArray(companies.data) ? companies.data : [];
  if (list.length === 1) companyId = String(list[0].id);
  else if (list.length > 1) {
    list.forEach((c, i) => console.log(`  [${i}] ${c.id} ${c.legalName ?? c.name ?? ""}`));
    const i = Number(await ask("Société (index) : ") || 0);
    companyId = String(list[i]?.id ?? "");
  }
}

saveSession({ cookie, companyId, email });
console.log(`OK, ${me.data?.profile?.firstName ?? ""} ${me.data?.profile?.lastName ?? ""} connecté. Société ${companyId || "?"}.`);
console.log(`Session enregistrée dans ${SESSION_FILE}`);
