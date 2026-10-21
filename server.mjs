#!/usr/bin/env node
// Mini MCP local pour l'API interne de Dougs (app.dougs.fr).
// Auth : cookie de session httpOnly. Le plus simple : `npm run login` (email + mot de passe + MFA),
// qui enregistre la session dans ~/.config/dougs-mcp/session.json. Le serveur la lit et la tient à jour.
//
// Variables d'env (facultatives, prioritaires sur le fichier de session) :
//   DOUGS_COOKIE        en-tête Cookie complet copié depuis DevTools
//   DOUGS_COMPANY_ID    ID société (URL app.dougs.fr/app/c/<ID>/)
//   DOUGS_SESSION_FILE  chemin du fichier de session
//   DOUGS_BASE_URL      (défaut https://app.dougs.fr)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BASE, SESSION_FILE, loadSession, saveSession, mergeCookies as merge, headers as baseHeaders } from "./session.mjs";

const stored = loadSession();
const COMPANY = process.env.DOUGS_COMPANY_ID || stored?.companyId || "";
let COOKIE = process.env.DOUGS_COOKIE || stored?.cookie || "";
const PERSIST = !process.env.DOUGS_COOKIE && !!stored;

if (!COOKIE || !COMPANY) {
  console.error(`Pas de session Dougs. Lance \`npm run login\` (fichier ${SESSION_FILE}) ou définis DOUGS_COOKIE et DOUGS_COMPANY_ID.`);
  process.exit(1);
}

// ---------- HTTP ----------
async function api(method, path, { query, body } = {}) {
  const url = new URL(BASE + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: baseHeaders(COOKIE),
    body: body ? JSON.stringify(body) : undefined,
  });
  // Le serveur peut renouveler le cookie de session : on le réinjecte.
  const setCookies = res.headers.getSetCookie?.() || [];
  if (setCookies.length) mergeCookies(setCookies);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === "object" && data?.message ? data.message : text.slice(0, 300);
    if (res.status === 401) throw new Error(`Session Dougs expirée : relance \`npm run login\` dans le dossier du MCP, puis redémarre-le.`);
    throw new Error(`Dougs ${method} ${url.pathname} -> ${res.status}: ${msg}`);
  }
  return data;
}

function mergeCookies(setCookies) {
  const next = merge(COOKIE, setCookies);
  if (next === COOKIE) return;
  COOKIE = next;
  if (PERSIST) { try { saveSession({ ...stored, cookie: COOKIE, companyId: COMPANY }); } catch (e) { console.error("save session:", e.message); } }
}

// Keepalive : même appel que le front (refreshSession=true) toutes les 10 min.
setInterval(() => {
  api("GET", "/users/me", { query: { refreshSession: true } }).catch(e => console.error("keepalive:", e.message));
}, 10 * 60 * 1000).unref();

// ---------- Cache catégories ----------
let categoriesCache = null;
async function categories() {
  if (!categoriesCache) categoriesCache = await api("GET", `/companies/${COMPANY}/categories`, { query: { full: true } });
  return categoriesCache;
}
async function categoryLabel(id) {
  const c = (await categories()).find(x => x.id === id);
  return c ? `${c.wording} (${c.accountingNumber ?? "?"})` : null;
}

// ---------- Formatage ----------
function summarizeOp(op) {
  return {
    id: op.id,
    date: op.date,
    wording: op.wording,
    memo: op.memo || undefined,
    amount: op.amount,
    sens: op.isInbound ? "entrée" : "sortie",
    validated: op.validated,
    needsAttention: op.needsAttention,
    type: op.type,
    breakdowns: (op.breakdowns || []).map(b => ({
      id: b.id,
      section: b.section,
      amount: b.amount,
      categoryId: b.categoryId,
      category: b.categoryWording,
      autocategorization: b.autocategorizationMethod || undefined,
      manuallyCategorized: b.isManuallyCategorized,
      hasVat: b.hasVat,
      vatRate: b.vatRate,
      vatAmount: b.vatAmount,
      vatManual: b.isVatAmountManuallyModified,
      isFee: b.isFee || undefined,
      isCounterpart: b.isCounterpart || undefined,
    })),
  };
}

const ok = obj => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = e => ({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });

// ---------- Serveur ----------
const server = new McpServer({ name: "dougs", version: "0.1.0" });

server.tool("dougs_whoami", "Vérifie que la session Dougs est valide et renvoie l'utilisateur connecté.", {}, async () => {
  try {
    const me = await api("GET", "/users/me");
    return ok({ ok: true, user: `${me?.profile?.firstName ?? ""} ${me?.profile?.lastName ?? ""}`.trim(), companyId: COMPANY });
  } catch (e) { return fail(e); }
});

server.tool(
  "dougs_list_operations",
  "Liste les opérations bancaires. Par défaut les non validées. Filtres texte/date/montant appliqués côté client sur la page récupérée.",
  {
    validated: z.boolean().default(false),
    needsAttention: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(40),
    offset: z.number().int().min(0).default(0),
    text: z.string().optional().describe("Filtre sur libellé/mémo (insensible à la casse)"),
    dateFrom: z.string().optional().describe("YYYY-MM-DD inclus"),
    dateTo: z.string().optional().describe("YYYY-MM-DD inclus"),
    inbound: z.boolean().optional().describe("true = encaissements, false = décaissements"),
    raw: z.boolean().default(false).describe("Renvoie l'objet brut Dougs"),
  },
  async a => {
    try {
      let ops = await api("GET", `/companies/${COMPANY}/operations`, {
        query: { limit: a.limit, offset: a.offset, needsAttention: a.needsAttention, validated: a.validated },
      });
      if (a.text) { const t = a.text.toLowerCase(); ops = ops.filter(o => `${o.wording} ${o.memo}`.toLowerCase().includes(t)); }
      if (a.dateFrom) ops = ops.filter(o => o.date >= a.dateFrom);
      if (a.dateTo) ops = ops.filter(o => o.date <= a.dateTo);
      if (a.inbound !== undefined) ops = ops.filter(o => o.isInbound === a.inbound);
      return ok({ count: ops.length, operations: a.raw ? ops : ops.map(summarizeOp) });
    } catch (e) { return fail(e); }
  }
);

server.tool("dougs_count_operations", "Compte les opérations validées ou non.", { validated: z.boolean().default(false) }, async a => {
  try { return ok(await api("GET", `/companies/${COMPANY}/operations/count-operations`, { query: { validated: a.validated } })); }
  catch (e) { return fail(e); }
});

server.tool(
  "dougs_get_operation",
  "Détail d'une opération (ventilation, catégories, TVA).",
  { operationId: z.number().int(), raw: z.boolean().default(false) },
  async a => {
    try {
      const op = await api("GET", `/companies/${COMPANY}/operations/${a.operationId}`);
      return ok(a.raw ? op : summarizeOp(op));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "dougs_search_categories",
  "Cherche dans le plan de catégories Dougs (libellé, mots-clés, n° de compte). Ne renvoie que les catégories assignables.",
  {
    query: z.string().optional(),
    inbound: z.boolean().optional().describe("true = catégories de recettes"),
    limit: z.number().int().default(25),
  },
  async a => {
    try {
      let cats = (await categories()).filter(c => c.isAssignable && !c.hidden);
      if (a.inbound !== undefined) cats = cats.filter(c => c.isInbound === a.inbound);
      if (a.query) {
        const q = a.query.toLowerCase();
        cats = cats.filter(c =>
          (c.wording || "").toLowerCase().includes(q) ||
          String(c.accountingNumber || "").startsWith(q) ||
          (c.groupName || "").toLowerCase().includes(q) ||
          (c.keywords || []).some(k => String(k).toLowerCase().includes(q)));
      }
      return ok(cats.slice(0, a.limit).map(c => ({
        id: c.id, wording: c.wording, accountingNumber: c.accountingNumber, group: c.groupName,
        isInbound: c.isInbound, vatDeductionType: c.vatDeductionType, description: c.description || undefined,
      })));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "dougs_suggest_categories",
  "Catégories préférées / suggérées par Dougs pour une ligne de ventilation.",
  { operationId: z.number().int(), breakdownId: z.number().int().optional() },
  async a => {
    try {
      let bId = a.breakdownId;
      if (!bId) {
        const op = await api("GET", `/companies/${COMPANY}/operations/${a.operationId}`);
        bId = op.breakdowns.find(b => b.section === "main")?.id ?? op.breakdowns[0]?.id;
      }
      const ids = await api("GET", `/companies/${COMPANY}/operations/${a.operationId}/breakdowns/${bId}/preferred-categories`);
      return ok({ breakdownId: bId, suggestions: await Promise.all(ids.map(async id => ({ id, label: await categoryLabel(id) }))) });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "dougs_categorize_operation",
  "Change la catégorie et/ou la TVA d'une ligne de ventilation, et peut valider l'opération. dryRun=true par défaut : affiche le payload sans l'envoyer.",
  {
    operationId: z.number().int(),
    breakdownId: z.number().int().optional().describe("Défaut : ligne 'main'"),
    categoryId: z.number().int().optional(),
    vatRate: z.number().optional().describe("Ex : 0.2, 0.1, 0.055, 0 (taux décimal)"),
    vatAmount: z.number().optional().describe("Montant de TVA forcé (manuel)"),
    vatExemptionReason: z.string().optional().describe("Obligatoire pour valider si la TVA passe à 0 sur une catégorie normalement taxée. Ex : exemption:outbound:nonApplicable (« la TVA n'est pas applicable »)"),
    validate: z.boolean().default(false),
    force: z.boolean().default(false).describe("Ajoute ?force=true comme le front"),
    dryRun: z.boolean().default(true),
  },
  async a => {
    try {
      const op = await api("GET", `/companies/${COMPANY}/operations/${a.operationId}`);
      const idx = a.breakdownId
        ? op.breakdowns.findIndex(b => b.id === a.breakdownId)
        : Math.max(0, op.breakdowns.findIndex(b => b.section === "main"));
      if (idx < 0) throw new Error("breakdown introuvable");
      const before = op.breakdowns[idx];
      const bk = { ...before };
      if (a.categoryId !== undefined) { bk.categoryId = a.categoryId; bk.isManuallyCategorized = true; }
      if (a.vatRate !== undefined) bk.vatRate = a.vatRate;
      if (a.vatAmount !== undefined) { bk.manualVatAmount = a.vatAmount; bk.vatAmount = a.vatAmount; bk.isVatAmountManuallyModified = true; }
      if (a.vatExemptionReason) bk.associationData = { ...(bk.associationData || {}), vatExemptionReason: a.vatExemptionReason };
      const breakdowns = op.breakdowns.map((b, i) => (i === idx ? bk : b));
      const body = { ...op, breakdowns, updatedBreakdown: bk, ...(a.validate ? { validated: true } : {}) };

      const diff = {
        operation: `${op.date} ${op.wording} ${op.isInbound ? "+" : "-"}${op.amount}`,
        breakdownId: bk.id,
        category: a.categoryId !== undefined ? `${before.categoryWording} -> ${await categoryLabel(a.categoryId)}` : undefined,
        vatRate: a.vatRate !== undefined ? `${before.vatRate} -> ${a.vatRate}` : undefined,
        vatAmount: a.vatAmount !== undefined ? `${before.vatAmount} -> ${a.vatAmount}` : undefined,
        validate: a.validate || undefined,
      };
      if (a.dryRun) return ok({ dryRun: true, diff });

      const updated = await api("POST", `/companies/${COMPANY}/operations/${op.id}`, {
        body, query: a.force ? { force: true } : undefined,
      });
      return ok({ applied: true, diff, result: summarizeOp(updated ?? (await api("GET", `/companies/${COMPANY}/operations/${op.id}`))) });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "dougs_validate_operation",
  "Valide (ou dévalide) une opération, comme le bouton du front.",
  { operationId: z.number().int(), validated: z.boolean().default(true), dryRun: z.boolean().default(true) },
  async a => {
    try {
      const op = await api("GET", `/companies/${COMPANY}/operations/${a.operationId}`);
      if (a.dryRun) return ok({ dryRun: true, operation: `${op.date} ${op.wording} ${op.amount}`, validated: `${op.validated} -> ${a.validated}` });
      const updated = await api("POST", `/companies/${COMPANY}/operations/${op.id}`, { body: { ...op, validated: a.validated } });
      return ok({ applied: true, result: summarizeOp(updated ?? op) });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "dougs_list_missing_receipts",
  "Opérations non validées sans justificatif rattaché (sourceDocumentAttachments vide).",
  {
    inbound: z.boolean().optional().describe("Défaut : toutes. false = dépenses seulement"),
    text: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(200),
  },
  async a => {
    try {
      let ops = await api("GET", `/companies/${COMPANY}/operations`, { query: { limit: a.limit, offset: 0, needsAttention: false, validated: false } });
      ops = ops.filter(o => !(o.sourceDocumentAttachments || []).length && o.amount !== 0);
      if (a.inbound !== undefined) ops = ops.filter(o => o.isInbound === a.inbound);
      if (a.text) { const t = a.text.toLowerCase(); ops = ops.filter(o => `${o.wording} ${o.memo}`.toLowerCase().includes(t)); }
      return ok({ count: ops.length, operations: ops.map(summarizeOp) });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "dougs_attach_receipt",
  "Rattache un fichier local (PDF/image) comme justificatif à une opération, comme le glisser-déposer du front. dryRun=true par défaut.",
  { operationId: z.number().int(), filePath: z.string(), dryRun: z.boolean().default(true) },
  async a => {
    try {
      const { readFile } = await import("node:fs/promises");
      const { basename, extname } = await import("node:path");
      const buf = await readFile(a.filePath);
      const op = await api("GET", `/companies/${COMPANY}/operations/${a.operationId}`);
      const info = { operation: `${op.date} ${op.wording} ${op.isInbound ? "+" : "-"}${op.amount}`, file: basename(a.filePath), bytes: buf.length,
        alreadyAttached: (op.sourceDocumentAttachments || []).length };
      if (a.dryRun) return ok({ dryRun: true, ...info });
      const mime = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }[extname(a.filePath).toLowerCase()] || "application/octet-stream";
      const form = new FormData();
      form.append("file", new Blob([buf], { type: mime }), basename(a.filePath));
      const h = baseHeaders(COOKIE); delete h["Content-Type"];
      const res = await fetch(`${BASE}/companies/${COMPANY}/operations/${op.id}/source-document-attachments/actions/create-from-formdata`, { method: "POST", headers: h, body: form });
      const sc = res.headers.getSetCookie?.() || []; if (sc.length) mergeCookies(sc);
      const text = await res.text();
      if (!res.ok) throw new Error(`upload -> ${res.status}: ${text.slice(0, 300)}`);
      return ok({ applied: true, ...info });
    } catch (e) { return fail(e); }
  }
);

server.tool("dougs_vat_configuration", "Régime de TVA configuré dans Dougs.", {}, async () => {
  try { return ok(await api("GET", `/companies/${COMPANY}/vat-configurations`)); } catch (e) { return fail(e); }
});

server.tool(
  "dougs_raw_request",
  "Appel brut à l'API Dougs (chemin relatif, ex: /companies/<ID>/operations/123/changes). Écritures bloquées sauf allowWrite=true.",
  {
    method: z.enum(["GET", "POST", "DELETE"]).default("GET"),
    path: z.string(),
    query: z.record(z.string()).optional(),
    body: z.any().optional(),
    allowWrite: z.boolean().default(false),
  },
  async a => {
    try {
      if (a.method !== "GET" && !a.allowWrite) throw new Error("Écriture refusée : passe allowWrite=true");
      return ok(await api(a.method, a.path, { query: a.query, body: a.body }));
    } catch (e) { return fail(e); }
  }
);

await server.connect(new StdioServerTransport());
