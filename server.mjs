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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
    q: z.string().optional().describe("Recherche serveur (paramètre q du front, ex: 'ventil'). Fonctionne avec validated explicite."),
    text: z.string().optional().describe("Filtre sur libellé/mémo (insensible à la casse)"),
    dateFrom: z.string().optional().describe("YYYY-MM-DD inclus"),
    dateTo: z.string().optional().describe("YYYY-MM-DD inclus"),
    inbound: z.boolean().optional().describe("true = encaissements, false = décaissements"),
    raw: z.boolean().default(false).describe("Renvoie l'objet brut Dougs"),
  },
  async a => {
    try {
      let ops = await api("GET", `/companies/${COMPANY}/operations`, {
        query: { limit: a.limit, offset: a.offset, needsAttention: a.needsAttention, validated: a.validated, q: a.q },
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

// ---------- Ventilation e-commerce (opérations type dispatch:ecommerce:salesChannel) ----------
// Le front n'utilise pas POST /operations/{id} pour ces opérations mais un endpoint dédié :
//   GET  /companies/{c}/operations/{id}/ecommerceSales               -> sections / subSections / sales
//   POST /companies/{c}/operations/{id}/ecommerceSales               -> crée une ligne (montant 0)
//   POST /companies/{c}/operations/{id}/ecommerceSales/{breakdownId} -> fixe le montant TTC, Dougs calcule la TVA
// La contrepartie (section main, catégorie Encaissement e-commerce) est recalculée par Dougs (léger délai).

// saleId des ventes de services B2C UE. La plupart = code ISO minuscule, sauf les pays dont le taux a changé
// (suffixe -taux) et la Grèce (el). Relevé dans le front Dougs, oct. 2026.
const EU_SALE_IDS = {
  AT: "at", BE: "be", BG: "bg", CY: "cy", CZ: "cz", DE: "de", DK: "dk", EE: "ee-24", ES: "es",
  FI: "fi-25.5", GR: "el", EL: "el", HR: "hr", HU: "hu", IE: "ie", IT: "it", LT: "lt", LU: "lu",
  LV: "lv", MT: "mt", NL: "nl", PL: "pl", PT: "pt", RO: "ro-21", SE: "se", SI: "si", SK: "sk-23",
};
const SALE_FR = "fr-20";
const SALE_OUTSIDE_EU = "exemption:inbound:outsideEuropeanUnion";

function saleTarget(country) {
  const c = country.trim().toUpperCase();
  if (c === "FR" || c === "FR-20") return { saleId: SALE_FR, selectedZone: "fr" };
  if (c === "HORS_UE" || c === "OUTSIDE_EU" || c === SALE_OUTSIDE_EU.toUpperCase()) return { saleId: SALE_OUTSIDE_EU, selectedZone: "exonerateSale" };
  if (EU_SALE_IDS[c]) return { saleId: EU_SALE_IDS[c], selectedZone: "eu" };
  return { saleId: country, selectedZone: "eu" }; // saleId Dougs brut (ex: "de-7")
}

async function ecommerceSales(opId) {
  const data = await api("GET", `/companies/${COMPANY}/operations/${opId}/ecommerceSales`);
  const sales = [];
  for (const s of data.sections || [])
    for (const ss of s.subSections || [])
      for (const sale of ss.sales || []) sales.push({ ...sale, sectionId: ss.sectionId ?? s.sectionId, subSectionId: ss.subSectionId });
  return { totalAmount: data.totalAmount, totalVatAmount: data.totalVatAmount, sales };
}

async function createSale(opId, saleId, selectedZone) {
  return api("POST", `/companies/${COMPANY}/operations/${opId}/ecommerceSales`, {
    body: { ecommerceSale: { sectionId: "service", subSectionId: "fr", saleId, selectedZone, packageId: "over150" } },
  });
}

async function setSaleAmount(opId, sale, amount) {
  return api("POST", `/companies/${COMPANY}/operations/${opId}/ecommerceSales/${sale.breakdownId}`, {
    body: { ecommerceSale: { ...sale, amount, sectionId: sale.sectionId || "service", subSectionId: sale.subSectionId || "fr" } },
  });
}

const r2 = x => Math.round(x * 100) / 100;

server.tool(
  "dougs_ecommerce_list_sales",
  "Liste les lignes d'une ventilation e-commerce (saleId, montant TTC, taux, TVA, breakdownId) et les totaux.",
  { operationId: z.number().int() },
  async a => {
    try {
      const { totalAmount, totalVatAmount, sales } = await ecommerceSales(a.operationId);
      return ok({
        totalTTC: r2(totalAmount), totalTVA: r2(totalVatAmount),
        sales: sales.map(s => ({ saleId: s.saleId, label: s.label, amount: s.amount, taxRate: s.taxRate, vatAmount: s.vatAmount, breakdownId: s.breakdownId, subSectionId: s.subSectionId })),
      });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "dougs_ecommerce_set_sale",
  "Crée ou met à jour une ligne de vente de services dans une ventilation e-commerce. country : FR, code ISO UE (BE, DE, GR...), HORS_UE, ou un saleId Dougs brut. Montant TTC. dryRun=true par défaut.",
  {
    operationId: z.number().int(),
    country: z.string(),
    amount: z.number().describe("Montant TTC (négatif pour un remboursement)"),
    dryRun: z.boolean().default(true),
  },
  async a => {
    try {
      const t = saleTarget(a.country);
      const { sales } = await ecommerceSales(a.operationId);
      const existing = sales.find(s => s.saleId === t.saleId);
      if (a.dryRun) return ok({ dryRun: true, ...t, action: existing ? `update ${existing.amount} -> ${a.amount}` : `create ${a.amount}` });
      const sale = existing || { ...(await createSale(a.operationId, t.saleId, t.selectedZone)), sectionId: "service", subSectionId: "fr" };
      const res = await setSaleAmount(a.operationId, sale, a.amount);
      return ok({ applied: true, saleId: res.saleId, amount: res.amount, taxRate: res.taxRate, vatAmount: res.vatAmount, totalTTC: r2(res.totalAmount), totalTVA: r2(res.totalVatAmount) });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "dougs_ecommerce_fill_from_csv",
  "Remplit une ventilation e-commerce depuis le CSV tva-reporting (colonnes Catégorie,Montant_TTC,Montant_HT,TVA,Taux). " +
  "Catégories reconnues : 'France - TVA 20%', '<Pays> (XX) - OSS ..%', 'Hors UE - Exonéré'. La ligne TOTAL est utilisée comme contrôle. " +
  "Compare la TVA calculée par Dougs à celle du CSV. dryRun=true par défaut.",
  {
    operationId: z.number().int(),
    csv: z.string().describe("Contenu du CSV"),
    dryRun: z.boolean().default(true),
  },
  async a => {
    try {
      const lines = a.csv.trim().split(/\r?\n/).slice(1).map(l => l.split(","));
      const rows = []; let total = null;
      for (const [cat, ttc, , tva] of lines) {
        if (!cat) continue;
        if (/^TOTAL/i.test(cat)) { total = { ttc: +ttc, tva: +tva }; continue; }
        let country;
        if (/^France/i.test(cat)) country = "FR";
        else if (/^Hors UE/i.test(cat)) country = "HORS_UE";
        else { const m = cat.match(/\(([A-Z]{2})\)/); if (!m) throw new Error(`Catégorie non reconnue : ${cat}`); country = m[1]; }
        rows.push({ cat, country, ttc: +ttc, tvaCsv: +tva, ...saleTarget(country) });
      }
      const { sales } = await ecommerceSales(a.operationId);
      const plan = rows.map(r => {
        const ex = sales.find(s => s.saleId === r.saleId);
        return { ...r, action: !ex ? "create" : ex.amount === r.ttc ? "unchanged" : `update ${ex.amount} -> ${r.ttc}` };
      });
      const sumTTC = r2(rows.reduce((t, r) => t + r.ttc, 0));
      if (total && Math.abs(sumTTC - total.ttc) > 0.005) throw new Error(`Somme des lignes ${sumTTC} != TOTAL ${total.ttc}`);
      if (a.dryRun) return ok({ dryRun: true, lines: plan.map(p => `${p.saleId} ${p.ttc} : ${p.action}`), sumTTC, total });

      const results = [];
      for (const p of plan) {
        if (p.action === "unchanged") { const ex = sales.find(s => s.saleId === p.saleId); results.push({ saleId: p.saleId, vatDougs: ex.vatAmount, vatCsv: p.tvaCsv }); continue; }
        const ex = sales.find(s => s.saleId === p.saleId);
        const sale = ex || { ...(await createSale(a.operationId, p.saleId, p.selectedZone)), sectionId: "service", subSectionId: "fr" };
        const res = await setSaleAmount(a.operationId, sale, p.ttc);
        results.push({ saleId: p.saleId, vatDougs: res.vatAmount, vatCsv: p.tvaCsv });
      }
      const after = await ecommerceSales(a.operationId);
      return ok({
        applied: true,
        totalTTC: r2(after.totalAmount), totalTVA: r2(after.totalVatAmount), csvTotal: total,
        ecartsTVA: results.filter(r => Math.abs(r.vatDougs - r.vatCsv) >= 0.005),
        note: "Commissions Stripe/Mollie non gérées : à saisir dans la section Commissions. Opération non validée.",
      });
    } catch (e) { return fail(e); }
  }
);

// Commissions d'une ventilation e-commerce (frais du prestataire de paiement, catégorie Commissions e-commerce).
// Les paymentsProcessorId sont propres à chaque compte Dougs : ils ne sont pas dans le code.
// Config locale : variable DOUGS_PAYMENT_PROCESSORS='{"stripe":123,"mollie":456}'
// ou fichier ~/.config/dougs-mcp/config.json { "paymentProcessors": { "stripe": 123 } }.
// Pour retrouver un id : dougs_ecommerce_list_sales sur un mois déjà ventilé (champ paymentsProcessorId des commissions).
function paymentProcessors() {
  let map = {};
  try { if (process.env.DOUGS_PAYMENT_PROCESSORS) map = JSON.parse(process.env.DOUGS_PAYMENT_PROCESSORS); } catch {}
  if (!Object.keys(map).length) {
    try { map = JSON.parse(readFileSync(join(homedir(), ".config", "dougs-mcp", "config.json"), "utf8")).paymentProcessors || {}; } catch {}
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), Number(v)]));
}

server.tool(
  "dougs_ecommerce_set_fee",
  "Crée ou met à jour la ligne de commissions d'un prestataire dans une ventilation e-commerce. processor = nom configuré localement (ex. stripe) ou paymentsProcessorId numérique. Montant = total de la facture de frais du mois. dryRun=true par défaut.",
  {
    operationId: z.number().int(),
    processor: z.string().describe("Nom configuré (DOUGS_PAYMENT_PROCESSORS / config.json) ou id numérique"),
    amount: z.number(),
    label: z.string().optional().describe("Libellé de la ligne (défaut : '<Nom> - <Nom>')"),
    dryRun: z.boolean().default(true),
  },
  async a => {
    try {
      const name = a.processor.toLowerCase();
      const pid = paymentProcessors()[name] || Number(a.processor);
      if (!pid) throw new Error(`processor « ${a.processor} » non configuré : définir DOUGS_PAYMENT_PROCESSORS ou ~/.config/dougs-mcp/config.json, ou passer l'id numérique`);
      const pretty = isNaN(Number(a.processor)) ? name.charAt(0).toUpperCase() + name.slice(1) : null;
      const known = { label: a.label ?? (pretty ? `${pretty} - ${pretty}` : undefined) };
      const { sales } = await ecommerceSales(a.operationId);
      const existing = sales.find(s => s.saleId === "fees" && s.paymentsProcessorId === pid);
      if (a.dryRun) return ok({ dryRun: true, paymentsProcessorId: pid, action: existing ? `update ${existing.amount} -> ${a.amount}` : `create ${a.amount}` });
      const sale = existing || await api("POST", `/companies/${COMPANY}/operations/${a.operationId}/ecommerceSales`, {
        body: { ecommerceSale: { sectionId: "fees", subSectionId: "fees", saleId: "fees", paymentsProcessorId: pid, label: known.label ?? String(pid) } },
      });
      const res = await api("POST", `/companies/${COMPANY}/operations/${a.operationId}/ecommerceSales/${sale.breakdownId}`, {
        body: { ecommerceSale: { ...sale, amount: a.amount, sectionId: "fees", subSectionId: "fees" } },
      });
      return ok({ applied: true, label: res.label, amount: res.amount, breakdownId: res.breakdownId });
    } catch (e) { return fail(e); }
  }
);

// ---------- Déclarations fiscales ----------
// GET /companies/{c}/declarations           -> liste (CA3, OSS, acomptes IS, CFE...)
// GET /companies/{c}/declarations/{id}      -> détail, champ `form` = cases du formulaire
// Autres routes vues dans le front (non testées) : list-declarations, count, completed-declaration-types,
// {id}/attachments, {id}/actions/confirm|unconfirm|reset|correct|generate-preview, {id}/remoteTransmissionStatus.

function declStatus(d) {
  if (d.confirmedAt) return "confirmée";
  if (d.isFuture) return "à venir";
  return d.isLate ? "en retard" : "à compléter";
}

function summarizeDecl(d) {
  return {
    id: d.id, type: d.type, label: d.label, statut: declStatus(d),
    periode: `${d.periodStartDate} -> ${d.periodEndDate}`, echeance: d.dueDate,
    montant: d.summaryAmount ?? undefined, depot: d.depositMode ?? undefined,
  };
}

// Pays OSS : clé Dougs (de, el, fi-25.5, de-7...) -> code du portail impots.gouv (DE, EL, FI...)
function ossRows(form) {
  const rows = [];
  for (const k of Object.keys(form)) {
    const m = k.match(/^([a-z]{2}(?:-[\d.]+)?):servicesVatRevenue$/);
    if (!m || !form[k]) continue;
    const key = m[1];
    rows.push({
      dougsKey: key,
      portalCode: key.split("-")[0].toUpperCase(),
      rate: parseFloat(String(form[`${key}:VAT:rate:services`]).replace(",", ".")),
      base: form[k],
      vatRounded: form[`${key}:servicesVATcredit`],
      vatBooked: form[`${key}:servicesVATcredit:detailedVatAccountNumber`],
    });
  }
  return rows.sort((x, y) => x.portalCode.localeCompare(y.portalCode));
}

server.tool(
  "dougs_list_declarations",
  "Liste les déclarations fiscales Dougs (CA3, OSS, acomptes IS, CFE...) avec statut, période, échéance et montant. Par défaut celles non confirmées.",
  { all: z.boolean().default(false).describe("Inclure les déclarations confirmées"), type: z.string().optional().describe("Filtre sur le type : CA3, OSS, 2571...") },
  async a => {
    try {
      let list = await api("GET", `/companies/${COMPANY}/declarations`);
      if (!a.all) list = list.filter(d => !d.confirmedAt);
      if (a.type) list = list.filter(d => d.type.toUpperCase().startsWith(a.type.toUpperCase()));
      list.sort((x, y) => (x.dueDate || "").localeCompare(y.dueDate || ""));
      return ok(list.map(summarizeDecl));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "dougs_get_declaration",
  "Détail d'une déclaration. OSS : tableau par pays (base, taux, TVA arrondie, TVA comptabilisée). CA3 : cases non nulles (08, A1, E3, 16, 20, 23, 25...).",
  { declarationId: z.number().int(), raw: z.boolean().default(false) },
  async a => {
    try {
      const d = await api("GET", `/companies/${COMPANY}/declarations/${a.declarationId}`);
      if (a.raw) return ok(d);
      const f = d.form || {};
      const out = { ...summarizeDecl(d) };
      if (d.type === "OSS") {
        const rows = ossRows(f);
        Object.assign(out, {
          pays: rows,
          totalBase: r2(rows.reduce((t, r) => t + r.base, 0)),
          totalTvaArrondie: r2(rows.reduce((t, r) => t + (r.vatRounded || 0), 0)),
          totalTvaPortail: r2(rows.reduce((t, r) => t + r.base * r.rate / 100, 0)),
          totalTvaComptabilisee: r2(rows.reduce((t, r) => t + (r.vatBooked || 0), 0)),
        });
      } else {
        // Cases CA3 : numéros (08, 16...), lettres (A1, E3...), en ignorant les sous-détails (car:..., x:VAT...)
        out.cases = Object.fromEntries(Object.entries(f).filter(([k, v]) => typeof v === "number" && v !== 0 && /^(\d{2}|[A-Z]\d?)$/.test(k)));
      }
      return ok(out);
    } catch (e) { return fail(e); }
  }
);

// Script navigateur pour remplir le guichet unique OSS (cfspro.impots.gouv.fr, page Opérations, JSF/Mojarra).
// Rejoue les requêtes du formulaire en séquence (pas en parallèle : l'état est porté par le ViewState),
// puis réaffiche la page résultante SANS recharger (un GET repart d'un formulaire vierge).
function ossPortalScript(rows) {
  const data = JSON.stringify(rows.map(r => [r.portalCode, r.rate, r.base]));
  return [
    "(async () => {",
    "const ROWS = " + data + ";",
    "const F = 'formSaisieOpeTaxable', url = location.pathname;",
    "let vs = document.querySelector('#' + F + ' input[name=\"javax.faces.ViewState\"]').value, last = '';",
    "const base = () => { const p = new URLSearchParams(); p.set(F, F); p.set('javax.faces.ViewState', vs); return p; };",
    "const grab = t => { const m = t.match(/javax\\.faces\\.ViewState[^>]*>\\s*<!\\[CDATA\\[([^\\]]+)\\]\\]>/) || t.match(/name=\"javax\\.faces\\.ViewState\"[^>]*value=\"([^\"]+)\"/); if (m) vs = m[1]; };",
    "const post = async (p, ajax) => { const r = await fetch(url, { method: 'POST', credentials: 'include', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, ajax ? { 'Faces-Request': 'partial/ajax' } : {}), body: p.toString() }); const t = await r.text(); grab(t); return t; };",
    "const ajax = (fields, src, render) => { const p = base(); fields.forEach(([k, v]) => p.set(F + ':' + k, v)); p.set('javax.faces.source', F + ':' + src); p.set('javax.faces.partial.event', 'change'); p.set('javax.faces.partial.execute', F + ':' + src + ' ' + F + ':' + src); p.set('javax.faces.partial.render', F + ':' + render); p.set('javax.faces.behavior.event', 'valueChange'); p.set('javax.faces.partial.ajax', 'true'); return post(p, true); };",
    "for (const [cc, rate, amt] of ROWS) {",
    "  const f = [['types-operations', 'SERVICES_MSID']]; await ajax(f, 'types-operations', 'panelBlocSaisieOperation');",
    "  f.push(['etat-membre-de-consommation', cc]); const t = await ajax(f, 'etat-membre-de-consommation', 'panelBlocSaisieOperation');",
    "  const doc = new DOMParser().parseFromString(t.replace(/^[\\s\\S]*?<!\\[CDATA\\[/, '').replace(/\\]\\]>[\\s\\S]*$/, ''), 'text/html');",
    "  const opt = [...doc.querySelectorAll('select[id$=\"taux\"] option')].find(o => parseFloat(o.textContent.replace(',', '.')) === rate);",
    "  if (!opt) throw new Error(cc + ' : taux ' + rate + ' introuvable');",
    "  f.push(['taux', opt.value]); await ajax(f, 'taux', 'panelBlocSaisieOperation');",
    "  f.push(['montant-taxable', String(amt)]); await ajax(f, 'montant-taxable', 'tva-due');",
    "  const p = base(); f.forEach(([k, v]) => p.set(F + ':' + k, v)); p.set(F + ':btnAjoutOperation', ''); last = await post(p, false);",
    "}",
    "document.open(); document.write(last); document.close();",
    "console.log('OSS : ' + ROWS.length + ' lignes ajoutées. Cliquer Enregistrer brouillon avant toute navigation.');",
    "})();",
  ].join("\n");
}

server.tool(
  "dougs_oss_portal_script",
  "Prépare le dépôt OSS sur impots.gouv : lit la déclaration OSS Dougs (par id, ou la prochaine non confirmée) et renvoie le tableau par pays et un script à exécuter dans la console de la page Opérations du guichet unique OSS. Le script ajoute toutes les lignes puis il faut cliquer « Enregistrer brouillon ». Il ne dépose rien.",
  { declarationId: z.number().int().optional() },
  async a => {
    try {
      let id = a.declarationId;
      if (!id) {
        const list = (await api("GET", `/companies/${COMPANY}/declarations`)).filter(d => d.type === "OSS" && !d.confirmedAt && !d.isFuture);
        list.sort((x, y) => (x.dueDate || "").localeCompare(y.dueDate || ""));
        if (!list.length) throw new Error("Aucune déclaration OSS à compléter");
        id = list[0].id;
      }
      const d = await api("GET", `/companies/${COMPANY}/declarations/${id}`);
      if (d.type !== "OSS") throw new Error(`La déclaration ${id} est de type ${d.type}, pas OSS`);
      const rows = ossRows(d.form || {});
      return ok({
        declaration: summarizeDecl(d),
        pays: rows.map(r => `${r.portalCode} ${r.rate}% base ${r.base} -> TVA portail ${r2(r.base * r.rate / 100)}`),
        totalBase: r2(rows.reduce((t, r) => t + r.base, 0)),
        totalTvaPortail: r2(rows.reduce((t, r) => t + r.base * r.rate / 100, 0)),
        etapes: [
          "Ouvrir https://cfspro.impots.gouv.fr/oss-mapiusager-cadriciel/xhtml/declarationtva/oss/operations.xhtml (période déjà choisie, aucune ligne saisie)",
          "Exécuter le script dans la console de la page (ou via l'outil javascript du navigateur)",
          "Cliquer « Enregistrer brouillon » sans recharger la page",
          "Vérifier, Suivant > Corrections > Récapitulatif > déposer, puis payer",
          "Dans Dougs : attacher accusé de réception, capture du récapitulatif et justificatif de paiement",
        ],
        script: ossPortalScript(rows),
      });
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
