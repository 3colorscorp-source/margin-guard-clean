"use strict";

const { MAX_MODULES } = require("./config");

const MODULES = [
  {
    id: "invoice-hub",
    title: "Invoice Hub",
    file: "invoice-hub.md",
    pages: ["/estimates-invoices", "/invoice"],
    keywords: [
      "invoice",
      "invoices",
      "invoice hub",
      "remaining balance",
      "progress payment",
      "start payment",
      "final payment",
      "material cost",
      "change order",
      "record payment",
      "payment history",
      "duplicate",
      "cancel invoice",
      "create invoice",
      "manual invoice",
      "public invoice",
      "send invoice",
      "draft invoice",
    ],
  },
  {
    id: "quote-builder",
    title: "Quote Builder",
    file: "quote-builder.md",
    pages: ["/owner", "/sales", "/create-estimate", "/seller"],
    keywords: [
      "quote",
      "quotes",
      "estimate",
      "recommended price",
      "recommended",
      "create a quote",
      "dueno",
      "vendedor",
      "publish",
      "send estimate",
      "labor",
    ],
  },
  {
    id: "business-settings",
    title: "Business Settings",
    file: "business-settings.md",
    pages: ["/business-settings", "/legal-notices"],
    keywords: [
      "minimum floor",
      "min floor",
      "protected floor",
      "minimum margin",
      "target margin",
      "business settings",
      "overhead",
      "payroll",
      "burden",
      "fica",
      "futa",
      "workers comp",
      "sui",
      "reserve",
      "labor rate",
      "pro base",
      "assistant base",
    ],
  },
  {
    id: "contract-hub",
    title: "Contract Hub",
    file: "contract-hub.md",
    pages: [
      "/contract-hub",
      "/contract-builder",
      "/signature-workspace",
      "/contract-sign",
    ],
    keywords: [
      "contract hub",
      "contract signing",
      "signature workspace",
      "contract builder",
      "freeze contract",
      "signing invitation",
      "service agreement",
    ],
  },
  {
    id: "financial-advisor",
    title: "Financial Advisor",
    file: "financial-advisor.md",
    pages: [],
    keywords: [
      "financial advisor",
      "owner financial advisor",
      "ai cfo",
      "chatgpt",
      "llm",
      "debt",
      "advisor",
    ],
  },
  {
    id: "dashboard",
    title: "Dashboard",
    file: "dashboard.md",
    pages: ["/dashboard", "/app"],
    keywords: [
      "dashboard",
      "financial command center",
      "cash",
      "runway",
      "treasury",
      "business health",
    ],
  },
  {
    id: "sales-admin",
    title: "Sales Admin",
    file: "sales-admin.md",
    pages: ["/sales-admin"],
    keywords: ["sales admin", "seller", "sellers", "owner review", "commission"],
  },
];

function normalizePath(page) {
  let p = String(page || "").trim().toLowerCase();
  if (!p) return "";
  try {
    if (p.startsWith("http")) {
      const u = new URL(p);
      p = u.pathname || "";
    }
  } catch (_err) {
    /* keep p */
  }
  p = p.split("?")[0].split("#")[0];
  if (p.endsWith(".html")) p = p.slice(0, -5);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}

function scoreModule(mod, text, pagePath) {
  let score = 0;
  if (pagePath && mod.pages.some((p) => pagePath === p || pagePath.startsWith(`${p}/`))) {
    score += 4;
  }
  for (const kw of mod.keywords) {
    if (text.includes(kw)) score += kw.length >= 12 ? 5 : 3;
  }
  return score;
}

/**
 * Pick 1–2 knowledge modules from page path + question keywords.
 * Deterministic. No embeddings.
 */
function routeSupportKnowledge(message, page) {
  const text = String(message || "").toLowerCase();
  const pagePath = normalizePath(page);

  const ranked = MODULES.map((mod) => ({
    mod,
    score: scoreModule(mod, text, pagePath),
  }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.mod.id.localeCompare(b.mod.id));

  const picked = [];
  for (const row of ranked) {
    if (picked.length >= MAX_MODULES) break;
    picked.push(row.mod);
  }

  if (picked.length === 0) {
    return [
      {
        id: "general",
        title: "Margin Guard Support",
        file: "README.md",
      },
      MODULES.find((m) => m.id === "dashboard"),
    ].filter(Boolean);
  }

  if (picked.length === 1 && picked[0].id === "financial-advisor") {
    const dash = MODULES.find((m) => m.id === "dashboard");
    if (dash) picked.push(dash);
  }
  if (picked.length === 1 && picked[0].id === "business-settings" && /floor|minimum|recommended/.test(text)) {
    const qb = MODULES.find((m) => m.id === "quote-builder");
    if (qb) picked.push(qb);
  }

  return picked.slice(0, MAX_MODULES);
}

module.exports = {
  MODULES,
  normalizePath,
  routeSupportKnowledge,
};
